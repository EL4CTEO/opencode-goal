import { beforeEach, describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/core/config.ts"
import type { GoalSnapshot, Notice, UsageSnapshot } from "../src/core/types.ts"
import { BackgroundTracker } from "../src/runtime/background.ts"
import { GoalController } from "../src/runtime/controller.ts"
import { createRouter } from "../src/runtime/events.ts"
import type { BackgroundWork, Clock, EvaluationRequest, EvaluationResult, StoragePort } from "../src/runtime/ports.ts"
import { GoalStore } from "../src/runtime/store.ts"

const SID = "ses_1"
const DIR = "C:/work/project"

class FakeClock implements Clock {
  t = 1_000_000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private next = 1
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (id: unknown) => void this.timers.delete(id as number)
  get pending() {
    return this.timers.size
  }
  async advance(ms: number) {
    this.t += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.t) continue
      this.timers.delete(id)
      timer.fn()
    }
    await flush()
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

class MemoryStorage implements StoragePort {
  data = new Map<string, unknown>()
  get = async (key: string) => structuredClone(this.data.get(key))
  set = async (key: string, value: unknown) => void this.data.set(key, structuredClone(value))
  remove = async (key: string) => void this.data.delete(key)
  scan = async ({ prefix }: { prefix: string }) => ({
    entries: [...this.data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
  })
}

function harness(options: Record<string, unknown> = {}, storage = new MemoryStorage()) {
  const clock = new FakeClock()
  const calls = { prompts: [] as any[], synthetic: [] as any[] }
  const verdicts: Array<EvaluationResult | Error | (() => Promise<EvaluationResult>)> = []
  const requests: EvaluationRequest[] = []
  const notices: Notice[] = []
  const changes: Array<GoalSnapshot | null> = []
  let work: BackgroundWork = { subagents: 0, shells: 0 }
  let usage: UsageSnapshot | undefined = { cost: 1, input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const store = new GoalStore(storage, (e) => {
    throw e
  })
  const silent = { info() {}, warn() {}, error() {} }
  const controller = new GoalController({
    config: resolveConfig(options),
    directory: DIR,
    clock,
    store,
    log: silent,
    newId: (() => {
      let n = 0
      return () => `goal_${++n}`
    })(),
    session: {
      prompt: async (input) => void calls.prompts.push(input),
      synthetic: async (input) => void calls.synthetic.push(input),
      usage: async () => usage,
    },
    evaluator: {
      evaluate: async (request) => {
        requests.push(request)
        const next = verdicts.shift()
        if (!next) throw new Error("no verdict queued")
        if (next instanceof Error) throw next
        return typeof next === "function" ? next() : next
      },
    },
    background: { busy: async () => work },
    emitter: { changed: (_, goal) => void changes.push(goal), notice: (n) => void notices.push(n) },
  })
  /** Simulates one complete agent turn. */
  const turn = async (tools = 1) => {
    controller.onExecutionStarted(SID)
    for (let i = 0; i < tools; i++) controller.onToolCalled(SID)
    await controller.onExecutionSucceeded(SID)
    await flush()
  }
  return {
    clock,
    calls,
    verdicts,
    requests,
    notices,
    changes,
    controller,
    storage,
    store,
    turn,
    setWork: (w: BackgroundWork) => void (work = w),
    setUsage: (u: UsageSnapshot | undefined) => void (usage = u),
    set: (condition = "all tests pass") => controller.command({ sessionID: SID, text: condition, delivery: "steer" }),
  }
}

const met = (reason = "done"): EvaluationResult => ({ verdict: "met", reason })
const notMet = (reason = "tests failing"): EvaluationResult => ({ verdict: "not_met", reason })

describe("GoalController", () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  test("setting a goal starts a turn with the condition as the directive", async () => {
    await h.set("lint is clean")
    expect(h.calls.prompts).toHaveLength(1)
    expect(h.calls.prompts[0].text).toContain("lint is clean")
    expect(h.controller.get(SID)?.status).toBe("active")
    expect(h.notices.at(-1)?.kind).toBe("set")
  })

  test("not met -> continuation turn carrying the evaluator reason; met -> achieved", async () => {
    await h.set()
    h.verdicts.push(notMet("2 tests still fail"))
    await h.turn()
    expect(h.calls.synthetic).toHaveLength(1)
    expect(h.calls.synthetic[0].text).toContain("2 tests still fail")
    expect(h.calls.synthetic[0].resume).toBeUndefined()
    expect(h.controller.get(SID)?.turns).toBe(1)

    h.verdicts.push(met("all 40 tests pass"))
    await h.turn()
    const goal = h.controller.get(SID)!
    expect(goal.status).toBe("achieved")
    expect(goal.turns).toBe(2)
    expect(goal.endedAt).toBeDefined()
    // The verdict note is recorded without waking the session.
    expect(h.calls.synthetic.at(-1).resume).toBe(false)
    expect(h.notices.some((n) => n.kind === "achieved")).toBeTrue()
  })

  test("evaluator receives turn number, elapsed time and spend since the goal was set", async () => {
    await h.set()
    h.clock.t += 90_000
    h.setUsage({ cost: 3, input: 600, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    h.verdicts.push(notMet())
    await h.turn()
    expect(h.requests[0]).toMatchObject({ turn: 1, elapsedMs: 90_000, spend: { cost: 2, input: 500, output: 50 } })
  })

  test("impossible clears the goal", async () => {
    await h.set()
    h.verdicts.push({ verdict: "impossible", reason: "the API does not exist" })
    await h.turn()
    expect(h.controller.get(SID)?.status).toBe("impossible")
    expect(h.controller.live(SID)).toBeUndefined()
  })

  test("stall guard pauses after N turns without tool use, and a user prompt resumes", async () => {
    await h.set()
    for (let i = 0; i < 3; i++) {
      h.verdicts.push(notMet())
      await h.turn(0)
    }
    expect(h.controller.get(SID)?.status).toBe("paused")
    expect(h.calls.synthetic).toHaveLength(2)
    h.controller.onUserPrompt(SID)
    expect(h.controller.get(SID)?.status).toBe("active")
    expect(h.controller.get(SID)?.stall).toBe(0)
  })

  test("hard turn limit pauses", async () => {
    h = harness({ maxTurns: 2 })
    await h.set()
    h.verdicts.push(notMet(), notMet())
    await h.turn()
    await h.turn()
    expect(h.controller.get(SID)?.status).toBe("paused")
    expect(h.controller.get(SID)?.reason).toContain("2-turn")
  })

  test("clear and aliases; status reports", async () => {
    await h.controller.command({ sessionID: SID, text: "", delivery: "steer" })
    expect(h.notices.at(-1)?.title).toBe("No goal set")
    await h.set()
    await h.controller.command({ sessionID: SID, text: "cancel", delivery: "steer" })
    expect(h.controller.get(SID)?.status).toBe("cleared")
    expect(h.notices.at(-1)?.message).toBe("all tests pass")
    await h.controller.command({ sessionID: SID, text: "off", delivery: "steer" })
    expect(h.notices.at(-1)?.title).toBe("No goal set")
  })

  test("a new goal replaces the active one", async () => {
    await h.set("first")
    await h.set("second")
    expect(h.controller.get(SID)?.condition).toBe("second")
    expect(h.notices.at(-1)?.title).toBe("Goal replaced")
  })

  test("clearing during evaluation drops the stale verdict", async () => {
    await h.set()
    let release!: (r: EvaluationResult) => void
    h.verdicts.push(() => new Promise((resolve) => (release = resolve)))
    h.controller.onExecutionStarted(SID)
    const ending = h.controller.onExecutionSucceeded(SID)
    await flush()
    expect(h.controller.snapshot(SID)?.evaluating).toBeTrue()
    h.controller.clear(SID)
    release(notMet())
    await ending
    expect(h.calls.synthetic).toHaveLength(0)
    expect(h.controller.get(SID)?.status).toBe("cleared")
  })

  test("a user turn starting mid-evaluation supersedes it", async () => {
    await h.set()
    let release!: (r: EvaluationResult) => void
    h.verdicts.push(() => new Promise((resolve) => (release = resolve)))
    const ending = h.controller.onExecutionSucceeded(SID)
    await flush()
    h.controller.onExecutionStarted(SID)
    release(notMet())
    await ending
    expect(h.calls.synthetic).toHaveLength(0)
    expect(h.controller.get(SID)?.turns).toBe(0)
  })

  test("background work defers evaluation and arms check-ins with backoff", async () => {
    await h.set()
    h.setWork({ subagents: 1, shells: 0 })
    await h.turn()
    expect(h.requests).toHaveLength(0)
    expect(h.controller.snapshot(SID)?.waiting).toBeTrue()
    await h.clock.advance(29 * 60_000)
    expect(h.calls.synthetic).toHaveLength(0)
    await h.clock.advance(60_000)
    expect(h.calls.synthetic).toHaveLength(1)
    expect(h.calls.synthetic[0].text).toContain("1 subagent")
    // The check-in turn ends with work still running: next check-in after 2x the interval.
    await h.turn(0)
    await h.clock.advance(59 * 60_000)
    expect(h.calls.synthetic).toHaveLength(1)
    await h.clock.advance(60_000)
    expect(h.calls.synthetic).toHaveLength(2)
    // Background finished: the next turn is evaluated, carrying earlier tool use.
    h.setWork({ subagents: 0, shells: 0 })
    h.verdicts.push(notMet())
    await h.turn(0)
    expect(h.requests).toHaveLength(1)
    expect(h.controller.get(SID)?.stall).toBe(0)
  })

  test("idle check-ins stop after the cap until the user prompts", async () => {
    h = harness({ maxIdleCheckins: 1 })
    await h.set()
    h.setWork({ subagents: 0, shells: 1 })
    await h.turn()
    await h.clock.advance(30 * 60_000)
    expect(h.calls.synthetic).toHaveLength(1)
    expect(h.notices.at(-1)?.message).toContain("paused until you send another prompt")
    await h.turn()
    await h.clock.advance(10 * 60 * 60_000)
    expect(h.calls.synthetic).toHaveLength(1)
  })

  test("transient failures retry with backoff, then pause", async () => {
    h = harness({ maxRetries: 2 })
    await h.set()
    h.controller.onExecutionStarted(SID)
    h.controller.onExecutionFailed(SID, { status: 529, message: "Overloaded" })
    expect(h.notices.at(-1)?.title).toBe("Goal still active")
    await h.clock.advance(15_000)
    expect(h.calls.synthetic).toHaveLength(1)
    expect(h.calls.synthetic[0].text).toContain("<goal-retry>")
    h.controller.onExecutionStarted(SID)
    h.controller.onExecutionFailed(SID, { message: "socket hang up, network error" })
    await h.clock.advance(60_000)
    expect(h.calls.synthetic).toHaveLength(2)
    h.controller.onExecutionStarted(SID)
    h.controller.onExecutionFailed(SID, { status: 503, message: "unavailable" })
    expect(h.controller.get(SID)?.status).toBe("paused")
  })

  test("fatal failures clear the goal; rate limits pause", async () => {
    await h.set()
    h.controller.onExecutionFailed(SID, { status: 401, message: "invalid api key" })
    expect(h.controller.get(SID)?.status).toBe("failed")
    expect(h.controller.get(SID)?.reason).toContain("Run /goal again")

    await h.set()
    h.controller.onExecutionFailed(SID, { status: 429, message: "slow down" })
    expect(h.controller.get(SID)?.status).toBe("paused")
  })

  test("checkinMinutes 0 disables retries", async () => {
    h = harness({ checkinMinutes: 0 })
    await h.set()
    h.controller.onExecutionFailed(SID, { status: 529, message: "Overloaded" })
    expect(h.controller.get(SID)?.status).toBe("paused")
  })

  test("user interrupt pauses; shutdown keeps the goal active", async () => {
    await h.set()
    h.controller.onExecutionInterrupted(SID, "shutdown")
    expect(h.controller.get(SID)?.status).toBe("active")
    h.controller.onExecutionInterrupted(SID, "user")
    expect(h.controller.get(SID)?.status).toBe("paused")
  })

  test("evaluator errors retry, then pause", async () => {
    h = harness({ maxRetries: 1 })
    await h.set()
    h.verdicts.push(new Error("boom"))
    await h.turn()
    expect(h.controller.get(SID)?.retries).toBe(1)
    h.verdicts.push(new Error("boom again"))
    await h.clock.advance(10_000)
    expect(h.controller.get(SID)?.status).toBe("paused")
    expect(h.controller.get(SID)?.reason).toContain("evaluator failed")
  })

  test("goals persist and restore with reset counters; finished goals are not restored", async () => {
    const storage = new MemoryStorage()
    const first = harness({}, storage)
    await first.set("restore me")
    first.verdicts.push(notMet())
    await first.turn()
    await first.store.flush()
    const second = harness({}, storage)
    expect(await second.controller.restore()).toBe(1)
    const goal = second.controller.get(SID)!
    expect(goal).toMatchObject({ condition: "restore me", status: "active", turns: 0 })

    second.controller.clear(SID)
    await second.store.flush()
    expect(await harness({}, storage).controller.restore()).toBe(0)
  })

  test("goals of deleted sessions are dropped on restore", async () => {
    const storage = new MemoryStorage()
    const first = harness({}, storage)
    await first.set()
    await first.store.flush()
    const second = harness({}, storage)
    second.setUsage(undefined)
    expect(await second.controller.restore()).toBe(0)
  })

  test("session deletion forgets the goal", async () => {
    await h.set()
    h.controller.onSessionDeleted(SID)
    expect(h.controller.get(SID)).toBeUndefined()
    expect(h.changes.at(-1)).toBeNull()
  })
})

describe("event router", () => {
  test("dedupes replayed events and routes shells/subagents to the tracker", async () => {
    const h = harness()
    const background = new BackgroundTracker({ parentOf: async () => undefined })
    const route = createRouter({ controller: h.controller, background, log: { info() {}, warn() {}, error() {} } })
    await h.set()
    route({ type: "session.created", data: { sessionID: "child", parentID: SID } })
    route({ type: "session.execution.started", data: { sessionID: "child" } })
    route({ type: "shell.created", data: { info: { id: "sh1", status: "running", metadata: { sessionID: SID } } } })
    expect(await background.busy(SID)).toEqual({ subagents: 1, shells: 1 })
    route({ type: "shell.exited", data: { id: "sh1", status: "exited" } })
    route({ id: "e1", type: "session.execution.succeeded", data: { sessionID: "child" } })
    expect(await background.busy(SID)).toEqual({ subagents: 0, shells: 0 })

    h.verdicts.push(notMet())
    route({ id: "e2", type: "session.execution.succeeded", data: { sessionID: SID } })
    route({ id: "e2", type: "session.execution.succeeded", data: { sessionID: SID } })
    await flush()
    expect(h.requests).toHaveLength(1)
  })

  test("grandchildren count as background work", async () => {
    const parents: Record<string, string> = { grandchild: "child", child: SID }
    const background = new BackgroundTracker({ parentOf: async (id) => parents[id] })
    background.executionStarted("grandchild")
    expect((await background.busy(SID)).subagents).toBe(1)
  })
})
