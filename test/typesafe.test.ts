import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('the README config example states the shipped default', () => {
  // The documented value and the shipped one drifted apart once already, and
  // nothing caught it until a reader did — twice. A review cannot be the only
  // thing standing between a user and a default the README contradicts, so the
  // example is parsed and compared here.
  //
  // Matched anchored and unquoted, which deliberately reaches the YAML config
  // block and not the JSON sample above it: that sample is a real historical
  // report, labelled as such, and its 0.8 is meant to stay.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const stated = [...readme.matchAll(/^[ \t]*threshold:[ \t]*([0-9.]+)[ \t]*$/gm)].map(match => Number(match[1]))
  assert.ok(stated.length > 0, 'the README must show a threshold in its config example')
  for (const value of stated) {
    assert.equal(value, defaultSemanticChecks[0]?.threshold, 'the README threshold must match the shipped default')
  }
})
