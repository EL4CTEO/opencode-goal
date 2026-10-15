import { isLive, type GoalRecord } from "../core/types.ts"
import type { StoragePort } from "./ports.ts"

const PREFIX = "goal/v1/"

export const keyFor = (sessionID: string) => `${PREFIX}${sessionID}`

/** Normalizes paths for cross-platform equality (case-insensitive drive letters, separators). */
export const sameDirectory = (a: string, b: string) => {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "")
  const left = norm(a)
  const right = norm(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isRecord(value: unknown): value is GoalRecord {
  if (typeof value !== "object" || value === null) return false
  const r = value as Partial<GoalRecord>
  return r.version === 1 && typeof r.sessionID === "string" && typeof r.condition === "string" && typeof r.status === "string"
}

/**
 * Durable goal persistence on plugin storage, one key per session. Writes per session are chained so they
 * land in order without blocking callers; the in-memory record stays the source of truth.
 */
export class GoalStore {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly storage: StoragePort,
    private readonly onError: (error: unknown) => void,
  ) {}

  save(record: GoalRecord): Promise<void> {
    const snapshot = structuredClone(record)
    return this.enqueue(record.sessionID, () => this.storage.set(keyFor(record.sessionID), snapshot))
  }

  remove(sessionID: string): Promise<void> {
    return this.enqueue(sessionID, () => this.storage.remove(keyFor(sessionID)))
  }

  /** Live goals owned by `directory`, for restore after a restart or plugin reload. */
  async loadLive(directory: string): Promise<GoalRecord[]> {
    const found: GoalRecord[] = []
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: PREFIX, limit: 200, ...(after ? { after } : {}) })
      for (const entry of page.entries)
        if (isRecord(entry.value) && isLive(entry.value.status) && sameDirectory(entry.value.directory, directory)) found.push(entry.value)
      after = page.next
    } while (after)
    return found
  }

  /** Resolves once every queued write has settled. */
  async flush(): Promise<void> {
    await Promise.all(this.chains.values())
  }

  private enqueue(sessionID: string, write: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(sessionID) ?? Promise.resolve()
    const next = previous.then(write).catch(this.onError)
    this.chains.set(sessionID, next)
    void next.then(() => {
      if (this.chains.get(sessionID) === next) this.chains.delete(sessionID)
    })
    return next
  }
}
