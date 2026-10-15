/**
 * Narrow interfaces the controller depends on. The plugin entry adapts OpenCode's context to them;
 * tests substitute fakes. Nothing in here imports OpenCode, so the core stays host-agnostic.
 */
import type { FailureInfo, GoalSnapshot, Notice, UsageSnapshot, Verdict } from "../core/types.ts"

export type Delivery = "steer" | "queue"

export interface PromptAttachments {
  readonly files?: ReadonlyArray<unknown>
  readonly agents?: ReadonlyArray<unknown>
  readonly skills?: ReadonlyArray<unknown>
}

export interface SessionPort {
  prompt(input: { sessionID: string; text: string; delivery: Delivery } & PromptAttachments): Promise<void>
  synthetic(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, string | number | boolean>
    delivery?: Delivery
    resume?: boolean
  }): Promise<void>
  /** Cumulative session spend, or undefined when unavailable. */
  usage(sessionID: string): Promise<UsageSnapshot | undefined>
}

export interface EvaluationRequest {
  readonly sessionID: string
  readonly condition: string
  readonly turn: number
  readonly elapsedMs: number
  readonly spend?: UsageSnapshot
  readonly signal: AbortSignal
}

export interface EvaluationResult {
  readonly verdict: Verdict
  readonly reason: string
}

export interface EvaluatorPort {
  evaluate(request: EvaluationRequest): Promise<EvaluationResult>
}

export interface BackgroundWork {
  readonly subagents: number
  readonly shells: number
}

export interface BackgroundPort {
  busy(sessionID: string): Promise<BackgroundWork>
}

export interface StoragePort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    readonly entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
    readonly next?: string
  }>
}

export interface EmitterPort {
  changed(sessionID: string, goal: GoalSnapshot | null): void
  notice(notice: Notice): void
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export type { FailureInfo }

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    // Never keep the host process alive just for a goal timer.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
