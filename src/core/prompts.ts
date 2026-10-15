import { formatDuration, formatSpend } from "./format.ts"
import type { UsageSnapshot } from "./types.ts"

/** Marks every message this plugin writes, so hooks and digests can recognize them. */
export const MARKER = "goal"

const escape = (text: string) => text.replace(/<\/(goal[\w-]*)>/gi, "<\\/$1>")

/** First turn: the condition itself is the directive. */
export function directive(condition: string): string {
  return [
    `<goal>`,
    escape(condition),
    `</goal>`,
    ``,
    // One line per paragraph: clients wrap prose themselves, hard breaks render as ragged lines.
    `Work autonomously toward this goal until the condition holds. After each of your turns an independent evaluator checks the condition using only what is visible in this conversation; it cannot run commands or read files.`,
    ``,
    `Prove progress with evidence: run the checks the condition implies and let their output show. Do not stop to ask for confirmation unless you are truly blocked.`,
  ].join("\n")
}

export function continuation(input: { condition: string; turn: number; reason: string }): string {
  return [
    `<goal-continuation turn="${input.turn}">`,
    `The goal is not met yet. Keep working toward it.`,
    ``,
    `Goal: ${escape(input.condition)}`,
    `Evaluator: ${escape(input.reason || "No reason given.")}`,
    ``,
    `Take the next concrete step, then show the evidence (command output, test results) that demonstrates the condition. If a turn or time limit in the goal applies, report progress against it.`,
    `</goal-continuation>`,
  ].join("\n")
}

export function retry(input: { condition: string; label: string }): string {
  return [
    `<goal-retry>`,
    `The previous turn failed (${input.label}). The goal is still active; continue from where you left off.`,
    `Goal: ${escape(input.condition)}`,
    `</goal-retry>`,
  ].join("\n")
}

export function checkin(input: { condition: string; waitedMs: number; subagents: number; shells: number }): string {
  const running = input.subagents + input.shells > 0
  const work = [
    input.subagents ? `${input.subagents} subagent${input.subagents === 1 ? "" : "s"}` : "",
    input.shells ? `${input.shells} background shell${input.shells === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ")
  return [
    `<goal-checkin>`,
    running
      ? `Background work (${work}) has kept the goal waiting for ${formatDuration(input.waitedMs)}. Read their output: keep waiting if they are progressing, and fix or stop any that are stuck.`
      : `Background work stopped without reporting a result. Continue toward the goal.`,
    `Goal: ${escape(input.condition)}`,
    `</goal-checkin>`,
  ].join("\n")
}

export function note(input: { title: string; body: string }): string {
  return `<goal-note>\n${input.title}\n${escape(input.body)}\n</goal-note>`
}

export function systemReminder(condition: string): string {
  return [
    `An active /goal is set for this session: ${escape(condition)}`,
    `An independent evaluator checks it after every turn from visible evidence only. Keep working until it holds and surface proof (command output, test results) in the conversation.`,
  ].join("\n")
}

export interface EvaluationFacts {
  /** The turn being evaluated (1-based). */
  readonly turn: number
  readonly elapsedMs: number
  readonly spend?: UsageSnapshot
}

const RUBRIC = [
  `Decide with these verdicts:`,
  `- "met": every part of the condition is demonstrated by evidence in the conversation (tool output, command`,
  `  results, file contents shown), or an explicit stop clause in the condition (turn, time, or budget limit) has`,
  `  been reached according to the harness facts below.`,
  `- "not_met": not demonstrated yet but still achievable. The reason must name what is missing or the next step.`,
  `- "impossible": can never be satisfied (self-contradictory, or depends on something verifiably unavailable).`,
  `  Use only with strong evidence; difficulty or slow progress is "not_met".`,
  ``,
  `Rules: claims without evidence do not count; if the agent says tests pass but no test output is visible, the`,
  `condition is not met. Judge the current state, not intentions. Constraints in the condition (things that must`,
  `not change) are part of it.`,
].join("\n")

const OUTPUT = `Reply with ONLY one JSON object and nothing else: {"verdict": "met" | "not_met" | "impossible", "reason": "<one or two sentences, under 300 characters>"}`

function facts(input: EvaluationFacts) {
  const lines = [
    `Harness facts (authoritative, measured outside the conversation):`,
    `- This is the end of turn ${input.turn} since the goal was set.`,
    `- Elapsed time: ${formatDuration(input.elapsedMs)}.`,
  ]
  if (input.spend) lines.push(`- Spend since the goal was set: ${formatSpend(input.spend)}.`)
  return lines.join("\n")
}

/** Appended to the live session transcript by `session.generate` (session evaluator). */
export function evaluateInSession(condition: string, input: EvaluationFacts): string {
  return [
    `<goal-evaluation>`,
    `Step out of the agent role. You are now an independent, skeptical evaluator auditing the conversation above.`,
    `Do not call tools, do not continue the work, and do not address the user.`,
    ``,
    `Condition:`,
    `<condition>${escape(condition)}</condition>`,
    ``,
    facts(input),
    ``,
    RUBRIC,
    ``,
    OUTPUT,
    `</goal-evaluation>`,
  ].join("\n")
}

/** Standalone prompt for an independent evaluator model reading a transcript digest. */
export function evaluateIndependently(condition: string, input: EvaluationFacts, transcript: string): string {
  return [
    `You are an independent, skeptical evaluator for an autonomous coding agent. Decide whether a completion`,
    `condition holds, judging only from the transcript below. You cannot run commands or read files.`,
    ``,
    `Condition:`,
    `<condition>${escape(condition)}</condition>`,
    ``,
    facts(input),
    ``,
    RUBRIC,
    ``,
    `<transcript>`,
    transcript,
    `</transcript>`,
    ``,
    OUTPUT,
  ].join("\n")
}

export const REPAIR = `Your previous reply was not valid. ${OUTPUT}`
