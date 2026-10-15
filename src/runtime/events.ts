import type { FailureInfo } from "../core/types.ts"
import type { BackgroundTracker } from "./background.ts"
import type { GoalController } from "./controller.ts"
import type { Logger } from "./ports.ts"

/** Minimal structural view of a server event; payloads are read defensively. */
export interface ServerEvent {
  readonly id?: string
  readonly type: string
  readonly data?: unknown
}

type Data = Record<string, any>

/** Remembers recently seen event IDs so a stream reconnect that replays events cannot double-fire a turn. */
export class RecentIds {
  private readonly seen = new Set<string>()
  constructor(private readonly capacity = 1024) {}

  /** Returns false if the ID was already seen. */
  add(id: string | undefined): boolean {
    if (!id) return true
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value as string)
    return true
  }
}

/** Fans one server event out to the background tracker and the goal controller. */
export function createRouter(input: { controller: GoalController; background: BackgroundTracker; log: Logger }) {
  const { controller, background, log } = input
  const recent = new RecentIds()
  const fail = (error: unknown) => log.error("goal event handler failed", { error: String(error) })

  return (event: ServerEvent) => {
    if (!recent.add(event.id)) return
    const data = (event.data ?? {}) as Data
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    switch (event.type) {
      case "session.execution.started":
        if (!sessionID) return
        background.executionStarted(sessionID)
        return controller.onExecutionStarted(sessionID)
      case "session.tool.called":
        if (sessionID) controller.onToolCalled(sessionID)
        return
      case "session.execution.succeeded":
        if (!sessionID) return
        background.executionEnded(sessionID)
        return void controller.onExecutionSucceeded(sessionID).catch(fail)
      case "session.execution.failed":
        if (!sessionID) return
        background.executionEnded(sessionID)
        return controller.onExecutionFailed(sessionID, data.error as FailureInfo | undefined)
      case "session.execution.interrupted":
        if (!sessionID) return
        background.executionEnded(sessionID)
        return controller.onExecutionInterrupted(sessionID, String(data.reason ?? "user"))
      case "session.created":
        if (sessionID) background.sessionCreated(sessionID, typeof data.parentID === "string" ? data.parentID : undefined)
        return
      case "session.deleted":
        if (!sessionID) return
        background.sessionDeleted(sessionID)
        return controller.onSessionDeleted(sessionID)
      case "shell.created": {
        const info = (data.info ?? {}) as Data
        if (typeof info.id === "string") background.shellCreated(info.id, String(info.status), info.metadata?.sessionID)
        return
      }
      case "shell.exited":
      case "shell.deleted":
        if (typeof data.id === "string" && (event.type === "shell.deleted" || data.status !== "running")) background.shellEnded(data.id)
        return
    }
  }
}
