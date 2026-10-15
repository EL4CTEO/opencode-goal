import type { GoalConfig } from "../core/config.ts"
import { classifyFailure } from "../core/errors.ts"
import { diffUsage, formatDuration, formatStatus, statusLabel, truncate } from "../core/format.ts"
import { parseGoalCommand } from "../core/parse.ts"
import * as Prompt from "../core/prompts.ts"
import {
  EMPTY_USAGE,
  isLive,
  type FailureInfo,
  type GoalRecord,
  type GoalSnapshot,
  type GoalStatus,
  type Notice,
  type NoticeKind,
  type NoticeLevel,
  type UsageSnapshot,
} from "../core/types.ts"
import type { BackgroundPort, BackgroundWork, Clock, Delivery, EmitterPort, EvaluatorPort, Logger, PromptAttachments, SessionPort } from "./ports.ts"
import type { GoalStore } from "./store.ts"

export interface ControllerDeps {
  readonly config: GoalConfig
  readonly directory: string
  readonly session: SessionPort
  readonly evaluator: EvaluatorPort
  readonly background: BackgroundPort
  readonly store: GoalStore
  readonly emitter: EmitterPort
  readonly clock: Clock
  readonly log: Logger
  readonly newId?: () => string
}

/** Volatile per-session state that never needs persisting. */
interface Runtime {
  /** Bumped by anything that invalidates in-flight async work (new turn, prompt, clear, replace). */
  epoch: number
  toolCalls: number
  /** Tool calls from turns whose evaluation was deferred by background work. */
  carriedToolCalls: number
  evaluating: boolean
  abort?: AbortController
  timer?: unknown
  deferredSince?: number
  lastCheckinAt?: number
}

const HISTORY = 20
const RETRY_BASE_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
const REEVALUATE_BASE_MS = 10_000

export type InterruptReason = "user" | "shutdown" | "superseded" | "inactivity" | (string & {})

/**
 * The /goal state machine. Event-driven, one record per session:
 *
 *   set -> active --turn ends--> evaluate --not_met--> continue (synthetic turn) --> ...
 *                                         --met/impossible--> terminal
 *   active --interrupt | stall | limit | non-retryable error--> paused --user prompt--> active
 *   active --fatal error--> failed       any --clear--> cleared
 *
 * Async work is guarded by an epoch per session: whenever the world moves on (a new execution starts, the user
 * prompts, the goal is cleared or replaced), stale evaluations and timers drop their results instead of racing.
 */
export class GoalController {
  private readonly goals = new Map<string, GoalRecord>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly running = new Set<string>()
  private readonly newId: () => string
  private disposed = false

  constructor(private readonly deps: ControllerDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  // ---------------------------------------------------------------- queries

  get(sessionID: string): GoalRecord | undefined {
    return this.goals.get(sessionID)
  }

  /** The active or paused goal, if any. */
  live(sessionID: string): GoalRecord | undefined {
    const record = this.goals.get(sessionID)
    return record && isLive(record.status) ? record : undefined
  }

  activeCondition(sessionID: string): string | undefined {
    const record = this.goals.get(sessionID)
    return record?.status === "active" ? record.condition : undefined
  }

  snapshot(sessionID: string, spend?: UsageSnapshot): GoalSnapshot | null {
    const record = this.goals.get(sessionID)
    if (!record) return null
    const runtime = this.runtimes.get(sessionID)
    return {
      ...structuredClone(record),
      elapsedMs: (record.endedAt ?? this.deps.clock.now()) - record.startedAt,
      evaluating: runtime?.evaluating ?? false,
      waiting: runtime?.deferredSince !== undefined,
      ...(spend ? { spend } : {}),
    }
  }

  list(): GoalSnapshot[] {
    return [...this.goals.keys()].map((id) => this.snapshot(id)).filter((s): s is GoalSnapshot => s !== null)
  }

  async spend(sessionID: string): Promise<UsageSnapshot | undefined> {
    const record = this.goals.get(sessionID)
    if (!record) return undefined
    if (record.final) return diffUsage(record.final, record.baseline)
    const usage = await this.deps.session.usage(sessionID).catch(() => undefined)
    return usage && diffUsage(usage, record.baseline)
  }

  // ---------------------------------------------------------------- commands

  /** Entry point for `/goal <args>`. */
  async command(input: { sessionID: string; text: string; delivery: Delivery } & PromptAttachments): Promise<void> {
    const parsed = parseGoalCommand(input.text, this.deps.config.maxConditionChars)
    switch (parsed.type) {
      case "status":
        return this.status(input.sessionID)
      case "clear":
        this.clear(input.sessionID)
        return
      case "invalid":
        this.notify(input.sessionID, "error", "error", "Goal not set", parsed.message)
        return
      case "set":
        return this.set({ ...input, condition: parsed.condition })
    }
  }

  async set(input: { sessionID: string; condition: string; delivery: Delivery } & PromptAttachments): Promise<void> {
    const { sessionID, condition } = input
    const previous = this.live(sessionID)
    if (previous) this.finish(previous, "cleared", "Replaced by a new goal.")
    const now = this.deps.clock.now()
    const baseline = (await this.deps.session.usage(sessionID).catch(() => undefined)) ?? EMPTY_USAGE
    const record: GoalRecord = {
      version: 1,
      id: this.newId(),
      sessionID,
      directory: this.deps.directory,
      condition,
      status: "active",
      setAt: now,
      startedAt: now,
      turns: 0,
      stall: 0,
      retries: 0,
      checkins: 0,
      baseline,
      history: [],
    }
    this.goals.set(sessionID, record)
    this.reset(sessionID)
    this.commit(record)
    this.notify(sessionID, "set", "info", previous ? "Goal replaced" : "Goal set", condition)
    try {
      await this.deps.session.prompt({
        sessionID,
        text: Prompt.directive(condition),
        delivery: input.delivery,
        ...(input.files?.length ? { files: input.files } : {}),
        ...(input.agents?.length ? { agents: input.agents } : {}),
        ...(input.skills?.length ? { skills: input.skills } : {}),
      })
    } catch (error) {
      if (this.goals.get(sessionID) === record) this.finish(record, "failed", `Could not start the goal: ${message(error)}`)
      throw error
    }
  }

  clear(sessionID: string): boolean {
    const record = this.live(sessionID)
    if (!record) {
      this.notify(sessionID, "cleared", "info", "No goal set", "There is no active goal in this session.")
      return false
    }
    this.finish(record, "cleared")
    this.notify(sessionID, "cleared", "info", "Goal cleared", record.condition)
    return true
  }

  async status(sessionID: string): Promise<void> {
    const record = this.goals.get(sessionID)
    if (!record) {
      this.notify(sessionID, "status", "info", "No goal set", "Set one with /goal <condition>.")
      return
    }
    const spend = await this.spend(sessionID)
    const text = formatStatus(record, this.deps.clock.now(), spend)
    const title = isLive(record.status) ? `Goal ${statusLabel(record.status)}` : record.status === "achieved" ? "No goal set \u00B7 last goal achieved" : "No goal set"
    this.notify(sessionID, "status", "info", title, text)
  }

  // ---------------------------------------------------------------- session events

  onExecutionStarted(sessionID: string) {
    this.running.add(sessionID)
    const runtime = this.runtimes.get(sessionID)
    if (!runtime) return
    this.invalidate(runtime)
    runtime.toolCalls = 0
  }

  onToolCalled(sessionID: string) {
    const runtime = this.runtimes.get(sessionID)
    if (runtime) runtime.toolCalls++
  }

  /** A user prompt was admitted (not synthetic). Resumes a paused goal and re-arms idle check-ins. */
  onUserPrompt(sessionID: string) {
    const record = this.live(sessionID)
    if (!record) return
    const runtime = this.runtime(sessionID)
    this.invalidate(runtime)
    record.checkins = 0
    runtime.lastCheckinAt = undefined
    if (record.status === "paused") {
      record.status = "active"
      record.reason = undefined
      record.stall = 0
      record.retries = 0
      this.notify(sessionID, "resumed", "info", "Goal resumed", record.condition)
    }
    this.commit(record)
  }

  async onExecutionSucceeded(sessionID: string): Promise<void> {
    this.running.delete(sessionID)
    const record = this.goals.get(sessionID)
    if (!record || record.status !== "active") return
    const runtime = this.runtime(sessionID)
    const epoch = ++runtime.epoch
    const tools = runtime.toolCalls
    runtime.toolCalls = 0
    const work = await this.deps.background.busy(sessionID).catch((): BackgroundWork => ({ subagents: 0, shells: 0 }))
    if (this.stale(record, runtime, epoch)) return
    if (work.subagents + work.shells > 0) return this.defer(record, runtime, work, tools)
    const carried = runtime.carriedToolCalls
    runtime.carriedToolCalls = 0
    runtime.deferredSince = undefined
    await this.evaluate(record, runtime, epoch, tools + carried)
  }

  onExecutionFailed(sessionID: string, error: FailureInfo | undefined) {
    this.running.delete(sessionID)
    const record = this.goals.get(sessionID)
    if (!record || record.status !== "active") return
    const runtime = this.runtime(sessionID)
    this.invalidate(runtime)
    runtime.carriedToolCalls += runtime.toolCalls
    runtime.toolCalls = 0
    this.handleFailure(record, runtime, classifyFailure(error))
  }

  onExecutionInterrupted(sessionID: string, reason: InterruptReason) {
    this.running.delete(sessionID)
    const record = this.goals.get(sessionID)
    if (!record || record.status !== "active") return
    const runtime = this.runtime(sessionID)
    this.invalidate(runtime)
    if (reason === "user") return this.pause(record, "Interrupted.")
    if (reason === "inactivity") return this.handleFailure(record, runtime, { kind: "transient", label: "inactivity timeout" })
    // shutdown: the goal persists and is restored; superseded: a newer execution owns the turn.
  }

  onSessionDeleted(sessionID: string) {
    this.running.delete(sessionID)
    const runtime = this.runtimes.get(sessionID)
    if (runtime) this.invalidate(runtime)
    this.runtimes.delete(sessionID)
    // Finished goals are not kept in memory after a restart, so always drop the stored record.
    void this.deps.store.remove(sessionID)
    if (this.goals.delete(sessionID)) this.deps.emitter.changed(sessionID, null)
  }

  // ---------------------------------------------------------------- lifecycle

  /** Restores live goals after a restart, resetting turn count, timer and spend baseline (Claude Code parity). */
  async restore(): Promise<number> {
    const records = await this.deps.store.loadLive(this.deps.directory)
    const now = this.deps.clock.now()
    await Promise.all(
      records.map(async (record) => {
        if (this.goals.has(record.sessionID)) return
        const usage = await this.deps.session.usage(record.sessionID).catch(() => undefined)
        if (!usage) {
          // The session no longer exists (or is unreachable): drop the stale goal.
          void this.deps.store.remove(record.sessionID)
          return
        }
        Object.assign(record, { startedAt: now, turns: 0, stall: 0, retries: 0, checkins: 0, baseline: usage })
        this.goals.set(record.sessionID, record)
        this.commit(record)
      }),
    )
    if (this.goals.size) this.deps.log.info("restored goals", { count: this.goals.size })
    return this.goals.size
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const runtime of this.runtimes.values()) this.invalidate(runtime)
    await this.deps.store.flush()
  }

  // ---------------------------------------------------------------- turn evaluation

  private async evaluate(record: GoalRecord, runtime: Runtime, epoch: number, tools: number): Promise<void> {
    const { config, clock, session } = this.deps
    const sessionID = record.sessionID
    const turn = record.turns + 1
    const stall = tools > 0 ? 0 : record.stall + 1
    const usage = await session.usage(sessionID).catch(() => undefined)
    if (this.stale(record, runtime, epoch)) return
    const abort = new AbortController()
    runtime.abort = abort
    runtime.evaluating = true
    this.emit(record)
    let result
    try {
      result = await this.deps.evaluator.evaluate({
        sessionID,
        condition: record.condition,
        turn,
        elapsedMs: clock.now() - record.startedAt,
        ...(usage ? { spend: diffUsage(usage, record.baseline) } : {}),
        signal: abort.signal,
      })
    } catch (error) {
      if (abort.signal.aborted || this.stale(record, runtime, epoch)) return
      runtime.evaluating = false
      return this.evaluationFailed(record, runtime, tools, error)
    } finally {
      if (runtime.abort === abort) {
        runtime.abort = undefined
        runtime.evaluating = false
      }
    }
    if (this.stale(record, runtime, epoch)) return

    record.turns = turn
    record.stall = stall
    record.retries = 0
    record.verdict = result.verdict
    record.reason = result.reason || undefined
    record.history.push({ turn, verdict: result.verdict, reason: result.reason, at: clock.now() })
    if (record.history.length > HISTORY) record.history.splice(0, record.history.length - HISTORY)

    if (result.verdict === "met") {
      this.finish(record, "achieved", result.reason)
      this.notify(sessionID, "achieved", "success", `Goal achieved in ${turn} turn${turn === 1 ? "" : "s"}`, result.reason || record.condition)
      return this.note(record, `Goal achieved (turn ${turn}, ${formatDuration(clock.now() - record.startedAt)}).`, result.reason)
    }
    if (result.verdict === "impossible") {
      this.finish(record, "impossible", result.reason)
      this.notify(sessionID, "impossible", "error", "Goal judged impossible", result.reason || record.condition)
      return this.note(record, "Goal cleared: the evaluator judged it impossible.", result.reason)
    }
    if (config.maxTurns > 0 && turn >= config.maxTurns) return this.pause(record, `Reached the ${config.maxTurns}-turn safety limit.`)
    if (stall >= config.stallTurns) return this.pause(record, `No progress: ${stall} turns in a row without tool use.`)
    this.commit(record)
    // A user turn already started: it gets evaluated when it ends, so don't stack a continuation on it.
    if (this.running.has(sessionID)) return
    await this.continueWith(record, {
      text: Prompt.continuation({ condition: record.condition, turn: turn + 1, reason: result.reason }),
      description: `goal \u00B7 turn ${turn + 1} \u00B7 ${truncate(result.reason || "not met yet", 90)}`,
      turn: turn + 1,
    })
  }

  private evaluationFailed(record: GoalRecord, runtime: Runtime, tools: number, error: unknown) {
    const { config, log } = this.deps
    log.warn("goal evaluation failed", { sessionID: record.sessionID, error: message(error) })
    if (config.checkinMinutes === 0 || record.retries >= config.maxRetries)
      return this.pause(record, `The evaluator failed: ${truncate(message(error), 160)}`)
    record.retries++
    const delay = Math.min(REEVALUATE_BASE_MS * 3 ** (record.retries - 1), RETRY_MAX_MS)
    this.commit(record)
    this.notify(record.sessionID, "retry", "warning", "Goal still active", `Evaluator failed (${truncate(message(error), 120)}); retrying in ${formatDuration(delay)}.`)
    this.schedule(runtime, delay, () => {
      if (this.goals.get(record.sessionID) !== record || record.status !== "active" || this.running.has(record.sessionID)) return
      void this.evaluate(record, runtime, ++runtime.epoch, tools).catch((e) => log.error("re-evaluation failed", { error: message(e) }))
    })
  }

  private handleFailure(record: GoalRecord, runtime: Runtime, failure: ReturnType<typeof classifyFailure>) {
    const { config } = this.deps
    if (failure.kind === "fatal") {
      const reason = `Goal cleared after an unrecoverable error: ${failure.label}. Run /goal again to continue.`
      this.finish(record, "failed", reason)
      this.notify(record.sessionID, "failed", "error", "Goal cleared", reason)
      return
    }
    if (failure.kind === "pause" || config.checkinMinutes === 0) return this.pause(record, `Turn failed: ${failure.label}.`)
    if (record.retries >= config.maxRetries) return this.pause(record, `Turn failed: ${failure.label} (after ${record.retries} automatic retries).`)
    record.retries++
    const delay = Math.min(RETRY_BASE_MS * 4 ** (record.retries - 1), RETRY_MAX_MS)
    this.commit(record)
    this.notify(record.sessionID, "retry", "warning", "Goal still active", `Turn failed (${failure.label}); retrying in ${formatDuration(delay)}.`)
    this.schedule(runtime, delay, () => {
      if (this.goals.get(record.sessionID) !== record || record.status !== "active" || this.running.has(record.sessionID)) return
      void this.continueWith(record, {
        text: Prompt.retry({ condition: record.condition, label: failure.label }),
        description: `goal \u00B7 retry ${record.retries}/${config.maxRetries}`,
        turn: record.turns + 1,
      })
    })
  }

  /** Background work is running: skip this evaluation and arm an idle check-in (30m, then x2 up to x4). */
  private defer(record: GoalRecord, runtime: Runtime, work: BackgroundWork, tools: number) {
    const { config, clock } = this.deps
    runtime.carriedToolCalls += tools
    const firstDefer = runtime.deferredSince === undefined
    runtime.deferredSince ??= clock.now()
    if (firstDefer) this.emit(record)
    if (config.checkinMinutes === 0 || record.checkins >= config.maxIdleCheckins) return
    const interval = config.checkinMinutes * 60_000 * Math.min(2 ** record.checkins, 4)
    const due = (runtime.lastCheckinAt ?? runtime.deferredSince) + interval
    this.schedule(runtime, Math.max(0, due - clock.now()), () => void this.checkin(record, runtime, work))
  }

  private async checkin(record: GoalRecord, runtime: Runtime, previous: BackgroundWork) {
    const { config, clock, background } = this.deps
    if (this.goals.get(record.sessionID) !== record || record.status !== "active" || this.running.has(record.sessionID)) return
    const epoch = runtime.epoch
    const work = await background.busy(record.sessionID).catch(() => previous)
    if (this.stale(record, runtime, epoch)) return
    record.checkins++
    runtime.lastCheckinAt = clock.now()
    const waitedMs = clock.now() - (runtime.deferredSince ?? clock.now())
    const last = record.checkins >= config.maxIdleCheckins
    this.commit(record)
    this.notify(
      record.sessionID,
      "checkin",
      "info",
      "Goal check-in",
      `Background work has kept the goal waiting ${formatDuration(waitedMs)}.${last ? " Idle check-ins are paused until you send another prompt." : ""}`,
    )
    await this.continueWith(record, {
      text: Prompt.checkin({ condition: record.condition, waitedMs, ...work }),
      description: `goal \u00B7 check-in ${record.checkins}`,
      turn: record.turns + 1,
    })
  }

  // ---------------------------------------------------------------- transitions

  private async continueWith(record: GoalRecord, input: { text: string; description: string; turn: number }) {
    try {
      await this.deps.session.synthetic({
        sessionID: record.sessionID,
        text: input.text,
        description: input.description,
        metadata: { source: Prompt.MARKER, goal: record.id, turn: input.turn },
        delivery: "steer",
      })
    } catch (error) {
      if (this.goals.get(record.sessionID) === record && record.status === "active") this.pause(record, `Could not continue: ${truncate(message(error), 160)}`)
    }
  }

  private pause(record: GoalRecord, reason: string) {
    const runtime = this.runtime(record.sessionID)
    this.invalidate(runtime)
    record.status = "paused"
    record.reason = reason
    this.commit(record)
    this.notify(record.sessionID, "paused", "warning", "Goal paused", `${reason} Send a message to resume, or /goal clear.`)
  }

  private finish(record: GoalRecord, status: Exclude<GoalStatus, "active" | "paused">, reason?: string) {
    const runtime = this.runtimes.get(record.sessionID)
    if (runtime) {
      this.invalidate(runtime)
      runtime.deferredSince = undefined
    }
    record.status = status
    if (reason) record.reason = reason
    record.endedAt = this.deps.clock.now()
    this.commit(record)
    void this.deps.session
      .usage(record.sessionID)
      .then((usage) => {
        if (!usage || this.goals.get(record.sessionID) !== record) return
        record.final = usage
        void this.deps.store.save(record)
      })
      .catch(() => {})
  }

  /** Records a verdict in the transcript without waking the session (like a shell notification). */
  private async note(record: GoalRecord, title: string, body: string) {
    if (!this.deps.config.transcriptNotes) return
    await this.deps.session
      .synthetic({
        sessionID: record.sessionID,
        text: Prompt.note({ title, body: body || record.condition }),
        description: title,
        metadata: { source: Prompt.MARKER, goal: record.id, final: true },
        delivery: "queue",
        resume: false,
      })
      .catch((error) => this.deps.log.warn("could not record goal note", { error: message(error) }))
  }

  // ---------------------------------------------------------------- plumbing

  private runtime(sessionID: string): Runtime {
    let runtime = this.runtimes.get(sessionID)
    if (!runtime) {
      runtime = { epoch: 0, toolCalls: 0, carriedToolCalls: 0, evaluating: false }
      this.runtimes.set(sessionID, runtime)
    }
    return runtime
  }

  /** Fresh runtime for a new goal; keeps the tool counter of a turn already in flight. */
  private reset(sessionID: string) {
    const previous = this.runtimes.get(sessionID)
    if (previous) this.invalidate(previous)
    this.runtimes.set(sessionID, {
      epoch: (previous?.epoch ?? 0) + 1,
      toolCalls: previous?.toolCalls ?? 0,
      carriedToolCalls: 0,
      evaluating: false,
    })
  }

  private invalidate(runtime: Runtime) {
    runtime.epoch++
    runtime.abort?.abort()
    runtime.abort = undefined
    runtime.evaluating = false
    if (runtime.timer !== undefined) this.deps.clock.clearTimeout(runtime.timer)
    runtime.timer = undefined
  }

  private schedule(runtime: Runtime, ms: number, callback: () => void) {
    if (runtime.timer !== undefined) this.deps.clock.clearTimeout(runtime.timer)
    runtime.timer = this.deps.clock.setTimeout(() => {
      runtime.timer = undefined
      if (!this.disposed) callback()
    }, ms)
  }

  private stale(record: GoalRecord, runtime: Runtime, epoch: number) {
    return this.disposed || runtime.epoch !== epoch || this.goals.get(record.sessionID) !== record || record.status !== "active"
  }

  private commit(record: GoalRecord) {
    void this.deps.store.save(record)
    this.emit(record)
  }

  private emit(record: GoalRecord) {
    if (this.goals.get(record.sessionID) !== record) return
    this.deps.emitter.changed(record.sessionID, this.snapshot(record.sessionID))
  }

  private notify(sessionID: string, kind: NoticeKind, level: NoticeLevel, title: string, body: string) {
    const notice: Notice = { sessionID, kind, level, title, message: body }
    this.deps.log.info(`${title}: ${truncate(body, 200)}`, { sessionID, kind })
    this.deps.emitter.notice(notice)
  }
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message)
  return String(error)
}
