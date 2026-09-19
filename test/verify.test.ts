import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyTaskResult } from '../src/verify.js'

const result = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  taskId: 'fix-login',
  status: 'done',
  summary: 'Fixed login validation.',
  changedFiles: ['src/login.ts'],
  testsClaimed: ['node --test'],
  blockers: [],
  ...overrides,
})

test('accepts a valid result with a passing configured test', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'typesafe-agent-'))
  await writeFile(join(workspace, 'login.ts'), 'export {}')
  await writeFile(join(workspace, 'sample.test.js'), "import test from 'node:test'; test('ok', () => {});")

  const report = await verifyTaskResult(result({ changedFiles: ['login.ts'] }), {
    workspaceRoot: workspace,
    verificationCommands: ['node --test'],
  })

  assert.equal(report.ready, true)
  assert.equal(report.tests[0]?.passed, true)
})

test('rejects invalid model output', async () => {
  const report = await verifyTaskResult('{not json}', { workspaceRoot: tmpdir() })
  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'INVALID_RESULT')
})

test('rejects paths outside workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'typesafe-agent-'))
  const report = await verifyTaskResult(result({ changedFiles: ['../secret.txt'] }), { workspaceRoot: workspace })
  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'PATH_OUTSIDE_WORKSPACE')
})
