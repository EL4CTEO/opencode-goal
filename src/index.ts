/**
 * opencode-goal: `/goal <condition>` for OpenCode v2.
 *
 * Sets a completion condition for the session; after every turn an evaluator checks it against the conversation
 * and, until it holds, the plugin starts the next turn itself. Mirrors Claude Code's /goal (status, clear aliases,
 * met / not met / impossible verdicts, stall guard, retries, background-work check-ins, restore on restart).
 */
import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./core/config.ts"
import { systemReminder } from "./core/prompts.ts"
import type { ModelRef, UsageSnapshot } from "./core/types.ts"
import { GoalRpc } from "./rpc.ts"
import { BackgroundTracker } from "./runtime/background.ts"
import { GoalController } from "./runtime/controller.ts"
import { Evaluator } from "./runtime/evaluator.ts"
import { createRouter, type ServerEvent } from "./runtime/events.ts"
import { systemClock, type EmitterPort, type Logger, type SessionPort } from "./runtime/ports.ts"
import { GoalStore } from "./runtime/store.ts"

export const PLUGIN_ID = "opencode-goal"

const DESCRIPTION = "keep working until a condition is met"

function createLogger(): Logger {
  const tag = `[${PLUGIN_ID}]`
  const extra = (value?: Record<string, unknown>) => (value ? [value] : [])
  return {
    info: (message, value) => console.info(tag, message, ...extra(value)),
    warn: (message, value) => console.warn(tag, message, ...extra(value)),
    error: (message, value) => console.error(tag, message, ...extra(value)),
  }
}

function toUsage(info: { cost?: number; tokens?: Partial<{ input: number; output: number; reasoning: number; cache: { read: number; write: number } }> }): UsageSnapshot {
  const tokens = info.tokens ?? {}
  return {
    cost: info.cost ?? 0,
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

const sessionIDOf = (input: unknown) => {
  const id = (input as { sessionID?: unknown } | undefined)?.sessionID
  if (typeof id !== "string" || id === "") throw new Error("sessionID is required")
  return id
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolveConfig(ctx.options, process.env)
    const log = createLogger()
    const lifetime = new AbortController()

    // ---- ports onto the OpenCode context
    const session: SessionPort = {
      prompt: async ({ sessionID, text, delivery, files, agents, skills }) => {
        await ctx.session.prompt({ sessionID, text, delivery, files, agents, skills } as Parameters<typeof ctx.session.prompt>[0])
      },
      synthetic: async (input) => {
        await ctx.session.synthetic(input as Parameters<typeof ctx.session.synthetic>[0])
      },
      usage: async (sessionID) => toUsage(await ctx.session.get({ sessionID })),
    }

    const evaluator = new Evaluator(
      {
        sessionGenerate: async (sessionID, prompt, signal) => (await ctx.session.generate({ sessionID, prompt }, { signal })).text,
        modelGenerate: async (model: ModelRef, prompt, signal) => (await ctx.generate.text({ prompt, model }, { signal })).text,
        context: (sessionID, signal) => ctx.session.context({ sessionID }, { signal }),
      },
      config.evaluator,
      log,
    )

    const background = new BackgroundTracker({
      parentOf: async (sessionID) => (await ctx.session.get({ sessionID })).parentID,
    })

    // RPC is registered after the controller exists; events emitted before that are simply dropped.
    let emit: EmitterPort = { changed: () => {}, notice: () => {} }
    const emitter: EmitterPort = {
      changed: (sessionID, goal) => emit.changed(sessionID, goal),
      notice: (notice) => emit.notice(notice),
    }

    const store = new GoalStore(ctx.storage, (error) => log.error("goal storage write failed", { error: String(error) }))
    const controller = new GoalController({
      config,
      directory: ctx.location.directory,
      session,
      evaluator,
      background,
      store,
      emitter,
      clock: systemClock,
      log,
    })

    // ---- RPC for clients (status line, dialogs, palette actions)
    const rpc = await ctx.rpc.register(GoalRpc, {
      get: async (input) => {
        const sessionID = sessionIDOf(input)
        return { goal: controller.snapshot(sessionID, await controller.spend(sessionID)) }
      },
      list: async () => ({ goals: controller.list() }),
      status: async (input) => {
        await controller.status(sessionIDOf(input))
        return {}
      },
      clear: async (input) => ({ cleared: controller.clear(sessionIDOf(input)) }),
    })
    const quiet = (error: unknown) => log.warn("goal event emit failed", { error: String(error) })
    emit = {
      changed: (sessionID, goal) => void rpc.events.emit("changed", { sessionID, goal }).catch(quiet),
      notice: (notice) => void rpc.events.emit("notice", { ...notice }).catch(quiet),
    }

    // ---- the /goal command
    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: DESCRIPTION,
        execute: async ({ sessionID, prompt, delivery }) => {
          await controller.command({
            sessionID,
            text: prompt.text ?? "",
            delivery,
            ...(prompt.files ? { files: prompt.files } : {}),
            ...(prompt.agents ? { agents: prompt.agents } : {}),
            ...(prompt.skills ? { skills: prompt.skills } : {}),
          })
        },
      })
    })

    // ---- hooks
    // Only real user prompts pass through this hook (synthetic continuations do not), so it is the resume signal.
    await ctx.session.hook("prompt", (event) => controller.onUserPrompt(event.sessionID))
    // Bound the evaluator's transient request without touching tools or system, which would break the cached prefix.
    await ctx.session.hook("generate", (event) => {
      if (evaluator.isEvaluating(event.sessionID)) event.options.maxTokens = config.evaluator.maxOutputTokens
    })
    if (config.systemReminder) {
      await ctx.session.hook("context", (event) => {
        const condition = controller.activeCondition(event.sessionID)
        if (condition) event.system.push({ type: "text", text: systemReminder(condition) })
      })
    }

    // ---- event pump with reconnect
    const route = createRouter({ controller, background, log })
    void (async () => {
      let backoff = 500
      while (!lifetime.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
            backoff = 500
            route(event as ServerEvent)
          }
        } catch (error) {
          if (lifetime.signal.aborted) break
          log.warn("event stream dropped; reconnecting", { error: String(error) })
        }
        await sleep(backoff, lifetime.signal)
        backoff = Math.min(backoff * 2, 15_000)
      }
    })()

    void controller.restore().catch((error) => log.error("goal restore failed", { error: String(error) }))
    log.info("ready", { evaluator: config.evaluator.mode, model: config.evaluator.model ?? "session" })

    return async () => {
      lifetime.abort()
      await controller.dispose()
    }
  },
})
