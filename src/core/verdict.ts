import type { Verdict } from "./types.ts"

export interface ParsedVerdict {
  readonly verdict: Verdict
  readonly reason: string
}

const MAX_REASON = 600

const SYNONYMS: ReadonlyArray<readonly [RegExp, Verdict]> = [
  [/^(not[\s_-]*(yet[\s_-]*)?met|unmet|not[\s_-]*done|incomplete|in[\s_-]*progress|continue|pending|no)$/i, "not_met"],
  [/^(impossible|unachievable|unsatisfiable|infeasible|blocked|cannot|can't)$/i, "impossible"],
  [/^(met|achieved|done|complete|completed|satisfied|success|yes|true|pass|passed)$/i, "met"],
]

export function normalizeVerdict(value: unknown): Verdict | undefined {
  if (typeof value === "boolean") return value ? "met" : "not_met"
  if (typeof value !== "string") return undefined
  const text = value.trim()
  for (const [pattern, verdict] of SYNONYMS) if (pattern.test(text)) return verdict
  return undefined
}

/**
 * Extracts the evaluator's verdict from free-form model output. Accepts strict JSON, JSON in a code fence
 * or surrounded by prose, and a `VERDICT: x` fallback. Returns undefined when nothing trustworthy is found.
 */
export function parseVerdict(text: string): ParsedVerdict | undefined {
  const cleaned = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim()
  for (const candidate of jsonObjects(cleaned)) {
    const parsed = safeJson(candidate)
    if (typeof parsed !== "object" || parsed === null) continue
    const record = parsed as Record<string, unknown>
    const verdict = normalizeVerdict(record.verdict ?? record.status ?? record.result ?? record.met)
    if (!verdict) continue
    return { verdict, reason: clampReason(record.reason ?? record.explanation ?? record.rationale) }
  }
  const line = /verdict\s*[:=]\s*["']?([a-z_\s-]+?)["']?\s*(?:[\n.;,]|$)/i.exec(cleaned)
  const verdict = line ? normalizeVerdict(line[1]) : undefined
  if (!verdict) return undefined
  const reason = /reason\s*[:=]\s*(.+)/i.exec(cleaned)?.[1]
  return { verdict, reason: clampReason(reason) }
}

function clampReason(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  if (text.length <= MAX_REASON) return text
  return `${text.slice(0, MAX_REASON - 1)}\u2026`
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Yields balanced top-level `{...}` spans, string-aware, in order of appearance. */
function* jsonObjects(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const char = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) {
        yield text.slice(start, i + 1)
        break
      }
    }
  }
}
