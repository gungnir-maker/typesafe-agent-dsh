import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultSemanticChecks, evaluateWithTypeSafe } from '../src/typesafe.js'
import type { VerificationReport } from '../src/contracts.js'

const report: VerificationReport = {
  ready: true,
  result: {
    taskId: 'fix-login',
    task: 'Fix login validation.',
    status: 'done',
    summary: 'Added validation.',
    changedFiles: ['src/login.ts'],
    testsClaimed: ['node --test'],
    blockers: [],
  },
  tests: [{ command: 'node --test', passed: true, output: '' }],
  semanticChecks: [],
  issues: [],
}

test('maps TypeSafe Noul answers to a threshold result', async () => {
  const checks = await evaluateWithTypeSafe(report, [{ id: 'complete', instructions: 'Is it complete?', threshold: 0.9 }], {
    apiKey: 'test-key',
    fetchFn: async () => new Response(JSON.stringify({ answers: { complete: { noul: 0.95 } } }), { status: 200 }),
  })

  assert.deepEqual(checks, [{ id: 'complete', score: 0.95, threshold: 0.9, passed: true }])
})

test('ships the calibrated default threshold', () => {
  // Pinned to a literal deliberately. The README recommends this number and a
  // user who enables `typesafe` without writing out `checks` gets exactly it,
  // so a default that drifts from the documentation is how honest work starts
  // getting refused again — which is precisely what happened at 0.8.
  assert.equal(defaultSemanticChecks[0]?.threshold, 0.6)
})

test('applies that default to a check naming no threshold of its own', async () => {
  const checks = await evaluateWithTypeSafe(report, [{ id: 'complete', instructions: 'Is it complete?' }], {
    apiKey: 'test-key',
    fetchFn: async () => new Response(JSON.stringify({ answers: { complete: { noul: 0.65 } } }), { status: 200 }),
  })

  // 0.65 sits inside the measured honest band; under the old 0.8 default this
  // same claim was refused.
  assert.deepEqual(checks, [{ id: 'complete', score: 0.65, threshold: 0.6, passed: true }])
})
