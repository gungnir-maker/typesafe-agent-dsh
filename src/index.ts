import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { verifyTaskResult } from './verify.js'
import type { VerifyOptions } from './contracts.js'

export * from './contracts.js'
export { parseTaskResult, verifyTaskResult } from './verify.js'

export const name = 'typesafe-agent-dsh'
export const inject = ['tools']

export type TypeSafeAgentDshConfig = Partial<VerifyOptions>

export function apply(ctx: Context, config: TypeSafeAgentDshConfig = {}) {
  ctx.tools.register(defineTool({
    name: 'typesafe_verify_task',
    description: 'Independently validate an agent completion claim. Use only after editing files and running the configured tests. Returns ready=true only when the typed result, changed files, and configured tests all pass.',
    parameters: {
      resultJson: { type: 'string', required: true, description: 'JSON matching the TypeSafe Agent task-result contract.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: { resultJson: string }, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { resultJson: string }) {
      return JSON.stringify(await verifyTaskResult(args.resultJson, {
        workspaceRoot: config.workspaceRoot ?? process.cwd(),
        verificationCommands: config.verificationCommands,
        allowedPathPrefixes: config.allowedPathPrefixes,
      }))
    },
  }))
}
