/** Lifecycle of a goal. `active` and `paused` are live; the rest are terminal. */
export type GoalStatus = "active" | "paused" | "achieved" | "impossible" | "cleared" | "failed"

export type Verdict = "met" | "not_met" | "impossible"

export const LIVE_STATUSES: ReadonlySet<GoalStatus> = new Set(["active", "paused"])

export const isLive = (status: GoalStatus) => LIVE_STATUSES.has(status)

export interface UsageSnapshot {
  readonly cost: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export const EMPTY_USAGE: UsageSnapshot = { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export interface VerdictEntry {
  readonly turn: number
  readonly verdict: Verdict
  readonly reason: string
  readonly at: number
}

/** Persisted goal state. Plain JSON so it round-trips through plugin storage. */
export interface GoalRecord {
  readonly version: 1
  readonly id: string
  readonly sessionID: string
  readonly directory: string
  readonly condition: string
  status: GoalStatus
  /** Latest evaluator reason, pause cause, or end reason. */
  reason?: string
  verdict?: Verdict
  readonly setAt: number
  /** Timer origin. Reset when a goal is restored after a restart. */
  startedAt: number
  endedAt?: number
  /** Evaluated turns. */
  turns: number
  /** Consecutive evaluated turns without tool use. */
  stall: number
  /** Automatic retries since the last successful turn. */
  retries: number
  /** Idle check-ins since the last user prompt. */
  checkins: number
  baseline: UsageSnapshot
  final?: UsageSnapshot
  history: VerdictEntry[]
}

/** Read model shared with clients over RPC. */
export interface GoalSnapshot extends GoalRecord {
  readonly elapsedMs: number
  /** An evaluation is in flight. */
  readonly evaluating: boolean
  /** Background work is holding evaluation back. */
  readonly waiting: boolean
  readonly spend?: UsageSnapshot
}

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface FailureInfo {
  readonly type?: string
  readonly message?: string
  readonly status?: number
}

export type NoticeLevel = "info" | "success" | "warning" | "error"

export type NoticeKind = "set" | "status" | "cleared" | "achieved" | "impossible" | "paused" | "resumed" | "retry" | "failed" | "checkin" | "error"

export interface Notice {
  readonly sessionID: string
  readonly kind: NoticeKind
  readonly level: NoticeLevel
  readonly title: string
  readonly message: string
}
