import type { SemanticCheck, SemanticCheckEvidence, VerificationReport } from './contracts.js'

const endpoint = 'https://api.typesafe.ai/v1/systemone'

/**
 * Shipped default, used by {@link defaultSemanticChecks} and by any configured
 * check that omits its own threshold.
 *
 * 0.6, not the 0.8 this started at. Measured across honest completions with a
 * green suite the score spanned 0.61-0.79, so 0.8 refused true work — the exact
 * failure that teaches users to ignore a gate. A user who enables `typesafe`
 * without writing out `checks` gets this number, so changing the recommendation
 * in the README without changing this leaves the default contradicting the
 * documentation. See "Calibrating the threshold" in the README.
 */
const defaultThreshold = 0.6

type TypeSafeResponse = {
  answers?: Record<string, { noul?: number }>
}

/** Default wall-clock bound for one TypeSafe request. */
const defaultRequestTimeoutMs = 30_000

/**
 * A response that arrived but cannot be trusted as a verdict.
 *
 * Distinct from a transport failure: the request succeeded, so retrying is not
 * the answer, and the caller reports it as its own issue code rather than
 * folding it into "unavailable".
 */
export class SemanticResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SemanticResponseError'
  }
}

export type TypeSafeOptions = {
  apiKey: string
  model?: string
  fetchFn?: typeof fetch
  /** Caller cancellation, forwarded to the request. */
  signal?: AbortSignal
  /** Per-request deadline; a request that never settles wedges the tool call. */
  timeoutMs?: number
}

export const defaultSemanticChecks: SemanticCheck[] = [{
  id: 'completion_is_supported',
  instructions: 'Based only on the stated task and verification evidence, is the completion claim supported well enough to hand off?',
  threshold: defaultThreshold,
}]

export async function evaluateWithTypeSafe(
  report: VerificationReport,
  checks: SemanticCheck[],
  options: TypeSafeOptions,
): Promise<SemanticCheckEvidence[]> {
  if (!report.result) throw new Error('A valid task result is required before semantic evaluation.')

  // Bounded like the shell commands are. A request that never settles leaves
  // the tool call with nothing to report, so the deadline is what makes the
  // caller's `timeoutMs` budget honest rather than hopeful.
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs ?? defaultRequestTimeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  let response: Response
  try {
    response = await (options.fetchFn ?? fetch)(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model ?? 'jev-latest',
        state: JSON.stringify({ task: report.result.task, result: report.result, tests: report.tests }),
        questions: Object.fromEntries(checks.map((check) => [check.id, {
          type: 'noul',
          instructions: check.instructions,
        }])),
      }),
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`TypeSafe request abandoned after ${options.timeoutMs ?? defaultRequestTimeoutMs}ms or on caller cancellation.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  if (!response.ok) throw new Error(`TypeSafe API returned HTTP ${response.status}.`)

  const payload = await response.json() as TypeSafeResponse
  return checks.map((check) => {
    const score = payload.answers?.[check.id]?.noul
    // A Noul score is a proportion. Anything outside [0, 1] is a malformed
    // response, and accepting one lets a gate that scores 9 pass every
    // threshold — reported as invalid rather than laundered into a pass.
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new SemanticResponseError(`TypeSafe returned a score outside [0, 1] for ${check.id}: ${String(score)}`)
    }
    const threshold = check.threshold ?? defaultThreshold
    return { id: check.id, score, threshold, passed: score >= threshold }
  })
}
