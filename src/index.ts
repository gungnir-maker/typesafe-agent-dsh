import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveApiKey } from './credentials.js'
import { verifyTaskResult } from './verify.js'
import { defaultSemanticChecks, evaluateWithTypeSafe } from './typesafe.js'
import type { SemanticCheck, VerifyOptions } from './contracts.js'

export * from './contracts.js'
export { credentialService, resolveApiKey } from './credentials.js'
export { parseTaskResult, verifyTaskResult } from './verify.js'
export { defaultSemanticChecks, evaluateWithTypeSafe } from './typesafe.js'

export const name = 'typesafe-agent-dsh'
export const inject = ['tools']

export type TypeSafeAgentDshConfig = Partial<VerifyOptions> & {
  typesafe?: {
    apiKeyEnv?: string
    model?: string
    checks?: SemanticCheck[]
  }
}

export function apply(ctx: Context, config: TypeSafeAgentDshConfig = {}) {
  ctx.tools.register(defineTool({
    name: 'typesafe_verify_task',
    description: 'Independently validate an agent completion claim. Use only after editing files and running configured tests. When TypeSafe is configured, it also evaluates semantic completion evidence. Returns ready=true only when every configured check passes.',
    parameters: {
      resultJson: { type: 'string', required: true, description: 'JSON matching the TypeSafe Agent task-result contract.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: { resultJson: string }, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { resultJson: string }) {
      const report = await verifyTaskResult(args.resultJson, {
        workspaceRoot: config.workspaceRoot ?? process.cwd(),
        verificationCommands: config.verificationCommands,
        allowedPathPrefixes: config.allowedPathPrefixes,
      })
      const typesafe = config.typesafe
      if (!report.ready || !typesafe) return JSON.stringify(report)

      const ref = typesafe.apiKeyEnv ?? 'TYPESAFE_API_KEY'
      const apiKey = await resolveApiKey(ctx, ref)
      if (apiKey === undefined) {
        report.ready = false
        report.issues.push({ code: 'TYPESAFE_UNAVAILABLE', message: `TypeSafe is configured but no credential resolves for ${ref}.` })
        return JSON.stringify(report)
      }

      try {
        report.semanticChecks = await evaluateWithTypeSafe(report, typesafe.checks ?? defaultSemanticChecks, {
          apiKey,
          model: typesafe.model,
        })
        for (const check of report.semanticChecks.filter((item) => !item.passed)) {
          report.issues.push({ code: 'SEMANTIC_CHECK_FAILED', message: `TypeSafe check failed: ${check.id} (${check.score} < ${check.threshold}).` })
        }
        report.ready = report.issues.length === 0
      } catch (error) {
        report.ready = false
        report.issues.push({ code: 'TYPESAFE_UNAVAILABLE', message: error instanceof Error ? error.message : 'TypeSafe evaluation failed.' })
      }

      return JSON.stringify(report)
    },
  }))
}
