import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateWithTypeSafe } from '../src/typesafe.js'
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
