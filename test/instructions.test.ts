import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPLETION_SECTION, COMPLETION_SECTION_ORDER, completionInstruction,
  registerCompletionInstruction, systemPromptService,
} from '../src/instructions.js'

/** A context stub exposing only the optional-service lookup the registrar uses. */
function context(systemPrompt: unknown): never {
  return { get: (name: string) => (name === 'systemPrompt' ? systemPrompt : undefined) } as never
}

test('registers the completion instruction under its stable name and order', () => {
  const registered: Array<{ name: string; order: number; text: string }> = []
  const dispose = (): void => {}
  const result = registerCompletionInstruction(context({
    section: (section: { name: string; order: number; text: string }) => {
      registered.push(section)
      return dispose
    },
  }))

  assert.equal(result, dispose)
  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.name, COMPLETION_SECTION)
  assert.equal(registered[0]?.order, COMPLETION_SECTION_ORDER)
  assert.equal(registered[0]?.text, completionInstruction())
})

test('places the section in the policy band, ahead of per-tool documentation', () => {
  // TEAM_POLICY is 600 and PTC_ONLY is 800 in the host's central table; the
  // instruction is a rule about finishing, so it must not drift into the
  // per-tool reference section.
  assert.ok(COMPLETION_SECTION_ORDER > 600, 'must sort after the team policy')
  assert.ok(COMPLETION_SECTION_ORDER < 800, 'must sort before the tool reference blocks')
})

test('names the tool the model is expected to call', () => {
  assert.match(completionInstruction(), /typesafe_verify_task/)
})

test('forbids restating a failed verdict and claiming unrun commands', () => {
  const text = completionInstruction()
  assert.match(text, /ready: false/)
  assert.match(text, /never claim a command you did not run/i)
})

test('is inert without a prompt registry, and ignores a registry without section()', () => {
  assert.equal(registerCompletionInstruction(context(undefined)), undefined)
  assert.equal(registerCompletionInstruction(context(null)), undefined)
  assert.equal(registerCompletionInstruction(context({ getSectionOrder: () => 1 })), undefined)
  assert.equal(systemPromptService(context('systemPrompt')), undefined)
})
