/**
 * The completion instruction this plugin contributes to the assembled prompt.
 *
 * Registering a verification tool is not the same as getting it called: a tool
 * the model is never told about stays dormant until a human asks for it, which
 * turns a gate into a suggestion. This section is what makes the gate
 * self-applying.
 *
 * Deliberately its own module: `index.ts` imports `@deepseek-ai/dsh-tools`,
 * which only resolves inside a DeepSeek Harness process, so anything living
 * there is untestable in this standalone package. This file depends on the
 * Harness context by type only.
 * @module typesafe-agent-dsh/instructions
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable section name; a second registration under it would shadow, not stack. */
export const COMPLETION_SECTION = 'typesafe:completion'

/**
 * Placement inside the assembled prompt.
 *
 * The policy band: after `TEAM_POLICY` (600) and before `PTC_ONLY` (800). This
 * is a rule about how to finish a task rather than documentation of one tool,
 * so it belongs with the other policies — early enough to be read before the
 * work, not appended after the per-tool reference where it reads as an
 * afterthought. The PromptSectionOrder names are a closed table with no entry
 * for a third-party gate, so the order is stated directly.
 */
export const COMPLETION_SECTION_ORDER = 650

/**
 * The slice of the prompt registry this plugin uses.
 *
 * Registration is per call and disposed with the calling context, so this file
 * never holds a subscription of its own.
 */
export type SystemPromptService = {
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * Narrow the optional prompt registry at runtime.
 *
 * A composition may mount no prompt registry at all, and the published package
 * is also loaded outside the Harness, so the shape is checked rather than
 * asserted. The tool still registers without it; only the instruction is lost.
 * @param ctx - plugin context.
 * @returns the service, or `undefined` when this composition mounts none.
 */
export function systemPromptService(ctx: Context): SystemPromptService | undefined {
  const candidate = ctx.get('systemPrompt')
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return undefined
  const section = (candidate as { section?: unknown }).section
  return typeof section === 'function' ? candidate as SystemPromptService : undefined
}

/**
 * The instruction text.
 *
 * Two things it must accomplish: give the model a trigger it can act on before
 * ending a turn, and remove the incentive to launder a `ready: false` into
 * softer prose. A gate that reports into a model free to re-narrate its verdict
 * is worth nothing, so the honesty clause is the load-bearing half.
 * @returns the section text.
 */
export function completionInstruction(): string {
  return [
    '## Claiming a task is done',
    '',
    'A task that changed files is not finished because the edits look right: it is finished when something other than you says so. Before you report completion, call `typesafe_verify_task` with a completion result naming the task, the files you changed, and the verification commands you actually ran.',
    '',
    'Report what it returns, failure included. `ready: false` is a finding to pass on with its issue codes — a failing rerun, a file outside the allowed paths, a semantic score under threshold — not an obstacle to work around or restate in softer words. Never describe work as verified because it looked correct, and never claim a command you did not run or a file you did not touch.',
  ].join('\n')
}

/**
 * Register the completion instruction in the calling context's scope.
 * @param ctx - plugin context; the prompt registry is optional.
 * @returns the registration disposer, or `undefined` when no registry is mounted.
 */
export function registerCompletionInstruction(ctx: Context): (() => void) | undefined {
  const systemPrompt = systemPromptService(ctx)
  if (systemPrompt === undefined) return undefined
  return systemPrompt.section({
    name: COMPLETION_SECTION,
    order: COMPLETION_SECTION_ORDER,
    text: completionInstruction(),
  })
}
