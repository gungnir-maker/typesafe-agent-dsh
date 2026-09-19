import type { SemanticCheck, SemanticCheckEvidence, VerificationReport } from './contracts.js'

const endpoint = 'https://api.typesafe.ai/v1/systemone'
const defaultThreshold = 0.8

type TypeSafeResponse = {
  answers?: Record<string, { noul?: number }>
}

export type TypeSafeOptions = {
  apiKey: string
  model?: string
  fetchFn?: typeof fetch
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

  const response = await (options.fetchFn ?? fetch)(endpoint, {
    method: 'POST',
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

  if (!response.ok) throw new Error(`TypeSafe API returned HTTP ${response.status}.`)

  const payload = await response.json() as TypeSafeResponse
  return checks.map((check) => {
    const score = payload.answers?.[check.id]?.noul
    if (typeof score !== 'number') throw new Error(`TypeSafe API omitted a Noul score for ${check.id}.`)
    const threshold = check.threshold ?? defaultThreshold
    return { id: check.id, score, threshold, passed: score >= threshold }
  })
}
