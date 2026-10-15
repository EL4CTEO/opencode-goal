/**
 * Renders session context into a compact, evidence-first digest for an independent evaluator.
 * Works on loosely typed messages so it tolerates schema additions across OpenCode releases.
 */

type Unknown = Record<string, unknown>

export interface DigestOptions {
  readonly maxChars: number
  /** Per-tool-output cap. Tails are kept: test runners and builds report results last. */
  readonly maxToolChars?: number
  readonly maxInputChars?: number
}

const str = (value: unknown) => (typeof value === "string" ? value : "")

function head(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026 [${text.length - max} chars cut]`
}

/** Keeps the start and, mostly, the end of long output. */
function headTail(text: string, max: number) {
  if (text.length <= max) return text
  const front = Math.floor(max * 0.25)
  const back = max - front
  return `${text.slice(0, front)}\n\u2026 [${text.length - max} chars cut] \u2026\n${text.slice(-back)}`
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((part: Unknown) => (part?.type === "text" ? str(part.text) : part?.type === "file" ? `[file ${str(part.name) || str(part.uri)}]` : ""))
    .filter(Boolean)
    .join("\n")
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function renderAssistant(message: Unknown, options: Required<DigestOptions>): string {
  const blocks: string[] = []
  const content = Array.isArray(message.content) ? (message.content as Unknown[]) : []
  for (const part of content) {
    if (part.type === "text" && str(part.text).trim()) blocks.push(str(part.text).trim())
    if (part.type !== "tool") continue
    const state = (part.state ?? {}) as Unknown
    const input = head(compactJson(state.input), options.maxInputChars)
    if (state.status === "completed") {
      blocks.push(`[tool ${str(part.name)}] ${input}\n${headTail(toolText(state.content), options.maxToolChars)}`)
    } else if (state.status === "error") {
      const error = (state.error ?? {}) as Unknown
      blocks.push(`[tool ${str(part.name)} FAILED] ${input}\n${headTail(str(error.message) || toolText(state.content), options.maxToolChars)}`)
    } else {
      blocks.push(`[tool ${str(part.name)} ${str(state.status) || "pending"}] ${input}`)
    }
  }
  const error = message.error as Unknown | undefined
  if (error && str(error.message)) blocks.push(`[turn error] ${str(error.message)}`)
  return blocks.length ? `ASSISTANT:\n${blocks.join("\n\n")}` : ""
}

export function renderMessage(message: unknown, options: Required<DigestOptions>): string {
  if (typeof message !== "object" || message === null) return ""
  const m = message as Unknown
  switch (m.type) {
    case "user":
      return str(m.text).trim() ? `USER:\n${head(str(m.text).trim(), options.maxToolChars)}` : ""
    case "synthetic":
      return str(m.text).trim() ? `NOTE:\n${head(str(m.text).trim(), options.maxToolChars)}` : ""
    case "assistant":
      return renderAssistant(m, options)
    case "shell": {
      const output = (m.output ?? {}) as Unknown
      return `[user shell] ${str(m.command)} (exit ${String(m.exit ?? "?")})\n${headTail(str(output.output), options.maxToolChars)}`
    }
    case "compaction":
      return m.status === "completed" && str(m.summary) ? `EARLIER CONTEXT (summary):\n${str(m.summary)}` : ""
    case "system":
      return ""
    default:
      return ""
  }
}

/** Newest-first packing under the character budget, then restored to chronological order. */
export function renderTranscript(messages: readonly unknown[], options: DigestOptions): string {
  const resolved: Required<DigestOptions> = {
    maxChars: options.maxChars,
    maxToolChars: options.maxToolChars ?? Math.max(1_500, Math.floor(options.maxChars / 12)),
    maxInputChars: options.maxInputChars ?? 400,
  }
  const picked: string[] = []
  let used = 0
  let omitted = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = renderMessage(messages[i], resolved)
    if (!block) continue
    if (used + block.length + 2 > resolved.maxChars) {
      if (picked.length === 0) {
        picked.push(headTail(block, resolved.maxChars))
        used = resolved.maxChars
        continue
      }
      omitted = i + 1
      break
    }
    picked.push(block)
    used += block.length + 2
  }
  picked.reverse()
  if (omitted > 0) picked.unshift(`[${omitted} earlier messages omitted]`)
  return picked.join("\n\n")
}
