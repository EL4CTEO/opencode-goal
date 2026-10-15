import type { GoalRecord, GoalStatus, UsageSnapshot } from "./types.ts"

export const GOAL_GLYPH = "\u25CE"

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

/** Minute-resolution duration for always-on indicators, so they re-render rarely. */
export function formatDurationCoarse(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0"
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`
}

export function diffUsage(current: UsageSnapshot, baseline: UsageSnapshot): UsageSnapshot {
  const d = (a: number, b: number) => Math.max(0, a - b)
  return {
    cost: d(current.cost, baseline.cost),
    input: d(current.input, baseline.input),
    output: d(current.output, baseline.output),
    reasoning: d(current.reasoning, baseline.reasoning),
    cacheRead: d(current.cacheRead, baseline.cacheRead),
    cacheWrite: d(current.cacheWrite, baseline.cacheWrite),
  }
}

export function formatSpend(spend: UsageSnapshot): string {
  const parts = [`${formatTokens(spend.input + spend.cacheRead + spend.cacheWrite)} in`, `${formatTokens(spend.output + spend.reasoning)} out`]
  if (spend.cacheRead > 0) parts.push(`${formatTokens(spend.cacheRead)} cached`)
  if (spend.cost > 0) parts.push(formatCost(spend.cost))
  return parts.join(" \u00B7 ")
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "active",
  paused: "paused",
  achieved: "achieved",
  impossible: "judged impossible",
  cleared: "cleared",
  failed: "cleared after an unrecoverable error",
}

export const statusLabel = (status: GoalStatus) => STATUS_LABEL[status]

export function elapsed(record: GoalRecord, now: number) {
  return (record.endedAt ?? now) - record.startedAt
}

/** Multi-line report used by `/goal` with no arguments. */
export function formatStatus(record: GoalRecord, now: number, spend: UsageSnapshot | undefined): string {
  const lines = [
    `Goal ${statusLabel(record.status)}: ${record.condition}`,
    `${record.endedAt ? "Ran" : "Running"} for ${formatDuration(elapsed(record, now))}${record.turns > 0 ? ` \u00B7 ${record.turns} turn${record.turns === 1 ? "" : "s"} evaluated` : ""}`,
  ]
  if (spend) lines.push(`Spend: ${formatSpend(spend)}`)
  if (record.reason) lines.push(`${record.status === "active" ? "Evaluator" : "Reason"}: ${record.reason}`)
  return lines.join("\n")
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`
}
