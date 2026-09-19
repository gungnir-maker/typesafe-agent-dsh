import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveApiKey } from './credentials.js'
import { registerCompletionInstruction } from './instructions.js'
import { verifyTaskResult } from './verify.js'
import { defaultSemanticChecks, evaluateWithTypeSafe } from './typesafe.js'
import { DEFAULT_COMMAND_TIMEOUT_MS } from './contracts.js'
import type { SemanticCheck, VerifyOptions } from './contracts.js'

export * from './contracts.js'
export { changedFiles, isGitWorkTree } from './changed.js'
export { credentialService, resolveApiKey } from './credentials.js'
export {
  COMPLETION_SECTION, COMPLETION_SECTION_ORDER, completionInstruction, registerCompletionInstruction,
} from './instructions.js'
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
  // Before the tool, so the instruction that tells the model to call it is in
  // place for the same assembly. Disposal rides the calling context, like the
  // tool registration below.
  registerCompletionInstruction(ctx)

  // Every command gets its own bound; the tool's budget is the sum plus a
  // margin, so the harness deadline lands after the per-command ones and a
  // single hung command is reported by the check that owns it.
  const commandBudget = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const commands = Math.max(1, config.verificationCommands?.length ?? 0)

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
    // Declaring a budget asserts what this tool now does: it forwards the
    // caller's signal to every command and kills the process group on abort, so
    // cancellation reaches quiescence instead of being ignored.
    timeoutMs: commandBudget * commands + 30_000,
    async execute(args: { resultJson: string }, exec?: { signal?: AbortSignal }) {
      const report = await verifyTaskResult(args.resultJson, {
        workspaceRoot: config.workspaceRoot ?? process.cwd(),
        verificationCommands: config.verificationCommands,
        allowedPathPrefixes: config.allowedPathPrefixes,
        commandTimeoutMs: config.commandTimeoutMs,
        verifyChanges: config.verifyChanges,
        ...exec?.signal === undefined ? {} : { signal: exec.signal },
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
