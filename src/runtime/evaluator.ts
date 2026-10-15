import type { GoalConfig } from "../core/config.ts"
import { evaluateIndependently, evaluateInSession, REPAIR } from "../core/prompts.ts"
import { renderTranscript } from "../core/transcript.ts"
import type { ModelRef } from "../core/types.ts"
import { parseVerdict } from "../core/verdict.ts"
import type { EvaluationRequest, EvaluationResult, EvaluatorPort, Logger } from "./ports.ts"

export interface EvaluatorDeps {
  /** Transient generation over the live session transcript; never persisted. */
  sessionGenerate(sessionID: string, prompt: string, signal: AbortSignal): Promise<string>
  /** Sessionless generation on a specific model. */
  modelGenerate(model: ModelRef, prompt: string, signal: AbortSignal): Promise<string>
  /** Current model-visible context of a session (post-compaction). */
  context(sessionID: string, signal: AbortSignal): Promise<readonly unknown[]>
}

export class EvaluationError extends Error {
  override readonly name = "EvaluationError"
}

/**
 * Judges a goal condition after each turn.
 *
 * `session` mode appends one question to the session's own transcript through `session.generate`: the provider
 * reuses the cached prefix, so evaluation costs roughly the question plus a short answer, with full-fidelity
 * evidence. `independent` mode sends a newest-first transcript digest to a separate (typically small, fast) model,
 * so completion is judged by a model other than the one doing the work. Independent failures fall back to session
 * mode once.
 */
export class Evaluator implements EvaluatorPort {
  private readonly inflight = new Map<string, number>()

  constructor(
    private readonly deps: EvaluatorDeps,
    private readonly config: GoalConfig["evaluator"],
    private readonly log: Logger,
  ) {}

  /** True while this plugin has a `session.generate` evaluation in flight for the session. */
  isEvaluating(sessionID: string) {
    return (this.inflight.get(sessionID) ?? 0) > 0
  }

  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.config.timeoutMs)])
    const facts = { turn: request.turn, elapsedMs: request.elapsedMs, ...(request.spend ? { spend: request.spend } : {}) }
    const model = this.config.model
    if (this.config.mode === "independent" && model) {
      try {
        const messages = await this.deps.context(request.sessionID, signal)
        const transcript = renderTranscript(messages, { maxChars: this.config.maxTranscriptChars })
        const prompt = evaluateIndependently(request.condition, facts, transcript)
        return await this.ask((text) => this.deps.modelGenerate(model, text, signal), prompt)
      } catch (error) {
        if (signal.aborted) throw error
        this.log.warn("independent evaluator failed; falling back to session evaluator", { error: String(error) })
      }
    }
    const prompt = evaluateInSession(request.condition, facts)
    this.inflight.set(request.sessionID, (this.inflight.get(request.sessionID) ?? 0) + 1)
    try {
      return await this.ask((text) => this.deps.sessionGenerate(request.sessionID, text, signal), prompt)
    } finally {
      const left = (this.inflight.get(request.sessionID) ?? 1) - 1
      if (left > 0) this.inflight.set(request.sessionID, left)
      else this.inflight.delete(request.sessionID)
    }
  }

  private async ask(generate: (prompt: string) => Promise<string>, prompt: string): Promise<EvaluationResult> {
    const first = await generate(prompt)
    const parsed = parseVerdict(first)
    if (parsed) return parsed
    // An empty answer usually means the model tried to call a tool; one stricter retry fixes most cases.
    const second = await generate(`${prompt}\n\n${REPAIR}`)
    const repaired = parseVerdict(second)
    if (repaired) return repaired
    throw new EvaluationError(`unreadable verdict: ${JSON.stringify((second || first).slice(0, 200))}`)
  }
}
