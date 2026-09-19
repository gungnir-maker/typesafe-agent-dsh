import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyTaskResult } from '../src/verify.js'

/** A claim naming one file and one command. */
const claim = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  taskId: 'limits',
  task: 'Exercise the verification bounds.',
  status: 'done',
  summary: 'Exercised the verification bounds.',
  changedFiles: ['committed.ts'],
  testsClaimed: ['node --test'],
  blockers: [],
  ...overrides,
})

/** Run git in a fixture, failing the test loudly if it refuses. */
function gitIn(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' })
}

/** A throwaway repo holding one committed file. */
async function repoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typesafe-limits-git-'))
  gitIn(dir, ['init', '-q'])
  gitIn(dir, ['config', 'user.email', 'test@example.com'])
  gitIn(dir, ['config', 'user.name', 'Test'])
  await writeFile(join(dir, 'committed.ts'), 'export const a = 1\n')
  gitIn(dir, ['add', '.'])
  gitIn(dir, ['commit', '-qm', 'init'])
  return dir
}

test('kills a command that outlives its budget instead of hanging', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'typesafe-budget-'))
  await writeFile(join(workspace, 'committed.ts'), 'export {}\n')

  // Sleeps far longer than the budget. Before the bound existed this promise
  // never settled and the tool call had nothing to report, ever.
  const started = Date.now()
  const report = await verifyTaskResult(claim({ testsClaimed: ['node -e "setTimeout(() => {}, 30000)"'] }), {
    workspaceRoot: workspace,
    verificationCommands: ['node -e "setTimeout(() => {}, 30000)"'],
    commandTimeoutMs: 1_000,
    verifyChanges: false,
  })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 15_000, `must not wait out the command (took ${elapsed}ms)`)
  assert.equal(report.tests[0]?.timedOut, true)
  assert.equal(report.tests[0]?.passed, false)
  assert.match(report.tests[0]?.output ?? '', /timed out after 1000ms/)
  assert.equal(report.issues[0]?.code, 'TEST_TIMED_OUT')
  assert.equal(report.ready, false)
})

test('honours a caller cancellation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'typesafe-abort-'))
  await writeFile(join(workspace, 'committed.ts'), 'export {}\n')

  const controller = new AbortController()
  setTimeout(() => { controller.abort() }, 300)
  const started = Date.now()
  const report = await verifyTaskResult(claim({ testsClaimed: ['node -e "setTimeout(() => {}, 30000)"'] }), {
    workspaceRoot: workspace,
    verificationCommands: ['node -e "setTimeout(() => {}, 30000)"'],
    commandTimeoutMs: 30_000,
    verifyChanges: false,
    signal: controller.signal,
  })

  assert.ok(Date.now() - started < 15_000, 'cancellation must end the work, not wait for the budget')
  assert.equal(report.tests[0]?.timedOut, true)
  assert.match(report.tests[0]?.output ?? '', /cancelled by caller/)
})

test('rejects a claimed file that is unmodified relative to HEAD', async () => {
  const repo = await repoFixture()
  const report = await verifyTaskResult(claim(), { workspaceRoot: repo })

  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'FILE_NOT_CHANGED')
})

test('accepts the same file once it is genuinely modified', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'committed.ts'), 'export const a = 2\n')
  const report = await verifyTaskResult(claim(), { workspaceRoot: repo })

  assert.deepEqual(report.issues, [])
  assert.equal(report.ready, true)
})

test('can be told to skip the change check', async () => {
  const repo = await repoFixture()
  const report = await verifyTaskResult(claim(), { workspaceRoot: repo, verifyChanges: false })
  assert.deepEqual(report.issues, [])
})

test('skips the change check outside a work tree rather than failing it', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'typesafe-plain-'))
  await writeFile(join(plain, 'committed.ts'), 'export {}\n')
  const report = await verifyTaskResult(claim(), { workspaceRoot: plain })

  assert.deepEqual(report.issues, [])
  assert.equal(report.ready, true)
})
