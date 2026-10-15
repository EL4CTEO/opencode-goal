export type GoalCommand =
  | { readonly type: "status" }
  | { readonly type: "clear" }
  | { readonly type: "set"; readonly condition: string }
  | { readonly type: "invalid"; readonly message: string }

/** Same aliases Claude Code accepts for `/goal clear`. */
export const CLEAR_ALIASES: ReadonlySet<string> = new Set(["clear", "stop", "off", "reset", "none", "cancel"])

/** `/goal` -> status, `/goal clear|stop|...` -> clear, anything else sets (or replaces) the goal. */
export function parseGoalCommand(raw: string, maxChars: number): GoalCommand {
  const text = raw.replace(/\r\n?/g, "\n").trim()
  if (text === "") return { type: "status" }
  if (CLEAR_ALIASES.has(text.toLowerCase())) return { type: "clear" }
  const condition = unquote(text)
  if (condition === "") return { type: "status" }
  if (condition.length > maxChars)
    return { type: "invalid", message: `Goal condition is ${condition.length} characters; the limit is ${maxChars}.` }
  return { type: "set", condition }
}

function unquote(text: string) {
  const first = text[0]
  if (text.length >= 2 && (first === '"' || first === "'" || first === "`") && text.endsWith(first)) return text.slice(1, -1).trim()
  return text
}
