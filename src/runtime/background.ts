import type { BackgroundPort, BackgroundWork } from "./ports.ts"

export interface BackgroundDeps {
  /** Parent session ID, or undefined for a root session. */
  parentOf(sessionID: string): Promise<string | undefined>
}

const MAX_DEPTH = 6

/**
 * Knows whether a session still has background work: running descendant sessions (subagents) or running shells
 * it started. Everything is fed from the event stream; parent links are immutable, so they are cached and only
 * looked up for sessions created before the plugin started listening.
 */
export class BackgroundTracker implements BackgroundPort {
  private readonly running = new Set<string>()
  private readonly shells = new Map<string, string>()
  private readonly parents = new Map<string, string | null>()

  constructor(private readonly deps: BackgroundDeps) {}

  executionStarted(sessionID: string) {
    this.running.add(sessionID)
  }

  executionEnded(sessionID: string) {
    this.running.delete(sessionID)
  }

  sessionCreated(sessionID: string, parentID: string | undefined) {
    this.parents.set(sessionID, parentID ?? null)
  }

  sessionDeleted(sessionID: string) {
    this.running.delete(sessionID)
    this.parents.delete(sessionID)
    for (const [id, owner] of this.shells) if (owner === sessionID) this.shells.delete(id)
  }

  shellCreated(id: string, status: string, owner: unknown) {
    if (status === "running" && typeof owner === "string") this.shells.set(id, owner)
  }

  shellEnded(id: string) {
    this.shells.delete(id)
  }

  async busy(sessionID: string): Promise<BackgroundWork> {
    let shells = 0
    for (const owner of this.shells.values()) if (owner === sessionID) shells++
    const others = [...this.running].filter((id) => id !== sessionID)
    if (others.length === 0) return { subagents: 0, shells }
    const checks = await Promise.all(others.map((id) => this.descendsFrom(id, sessionID)))
    return { subagents: checks.filter(Boolean).length, shells }
  }

  private async descendsFrom(sessionID: string, ancestor: string): Promise<boolean> {
    let current: string | undefined = sessionID
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      const parent = await this.parent(current)
      if (parent === ancestor) return true
      current = parent
    }
    return false
  }

  private async parent(sessionID: string): Promise<string | undefined> {
    const cached = this.parents.get(sessionID)
    if (cached !== undefined) return cached ?? undefined
    try {
      const parent = await this.deps.parentOf(sessionID)
      this.parents.set(sessionID, parent ?? null)
      return parent
    } catch {
      // Not cached: a failed lookup must not mark a subagent as a root forever.
      return undefined
    }
  }
}
