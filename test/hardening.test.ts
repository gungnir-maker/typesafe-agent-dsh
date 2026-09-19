import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SemanticResponseError, evaluateWithTypeSafe } from '../src/typesafe.js'
import { verifyTaskResult } from '../src/verify.js'
import type { VerificationReport } from '../src/contracts.js'

/** A claim that passes everything except the behaviour under test. */
const claim = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  taskId: 'hardening',
  task: 'Exercise the file-policy hardening.',
  status: 'done',
  summary: 'Exercised the file-policy hardening.',
  changedFiles: ['src/real.ts'],
  testsClaimed: [],
  blockers: [],
  ...overrides,
})

/** A workspace with one real file under `src`, and one file outside it. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'typesafe-hard-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'real.ts'), 'export {}\n')
  await writeFile(join(root, 'outside.txt'), 'not in src\n')
  return root
}

/** Run git in a fixture. */
function gitIn(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' })
}

/** A repo with one committed file under `src`. */
async function repoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typesafe-hard-git-'))
  gitIn(dir, ['init', '-q'])
  gitIn(dir, ['config', 'user.email', 'test@example.com'])
  gitIn(dir, ['config', 'user.name', 'Test'])
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'real.ts'), 'export {}\n')
  gitIn(dir, ['add', '.'])
  gitIn(dir, ['commit', '-qm', 'init'])
  return dir
}

test('rejects a traversal that lands outside the allowed prefix', async () => {
  const root = await workspace()
  // `src/../outside.txt` starts with `src/`, so a prefix test that runs before
  // normalization accepts it while the file sits outside the allowed area.
  const report = await verifyTaskResult(claim({ changedFiles: ['src/../outside.txt'] }), {
    workspaceRoot: root,
    allowedPathPrefixes: ['src'],
    verifyChanges: false,
  })
  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'PATH_OUTSIDE_WORKSPACE')
})

test('rejects an absolute path and a bare parent traversal', async () => {
  const root = await workspace()
  for (const claimed of ['/etc/passwd', '../outside.txt', 'src/../../outside.txt']) {
    const report = await verifyTaskResult(claim({ changedFiles: [claimed] }), { workspaceRoot: root, verifyChanges: false })
    assert.equal(report.ready, false, `${claimed} must be refused`)
    assert.equal(report.issues[0]?.code, 'PATH_OUTSIDE_WORKSPACE', `${claimed} must be a path issue`)
  }
})

test('rejects a symlink that resolves outside the workspace', async () => {
  const root = await workspace()
  const far = await mkdtemp(join(tmpdir(), 'typesafe-far-'))
  await writeFile(join(far, 'target.txt'), 'elsewhere\n')
  await symlink(join(far, 'target.txt'), join(root, 'src', 'link.ts'))

  // The link exists and its lexical path is inside `src`; only the resolved
  // path reveals that it escapes.
  const report = await verifyTaskResult(claim({ changedFiles: ['src/link.ts'] }), {
    workspaceRoot: root,
    verifyChanges: false,
  })
  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'PATH_OUTSIDE_WORKSPACE')
})

test('refuses a done claim that reports its own blockers', async () => {
  const root = await workspace()
  const report = await verifyTaskResult(claim({ blockers: ['Still broken'] }), {
    workspaceRoot: root,
    verifyChanges: false,
  })
  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'BLOCKERS_REPORTED')
})

test('refuses a done claim with nothing to verify', async () => {
  const root = await workspace()
  // No files and no configured command: every rule was satisfied vacuously and
  // this used to report success.
  const report = await verifyTaskResult(claim({ changedFiles: [] }), { workspaceRoot: root })
  assert.equal(report.ready, false)
  assert.equal(report.issues[0]?.code, 'NO_EVIDENCE')
})

test('accepts a deletion as a change rather than demanding the file exist', async () => {
  const repo = await repoFixture()
  await rm(join(repo, 'src', 'real.ts'))

  const report = await verifyTaskResult(claim(), { workspaceRoot: repo })
  assert.deepEqual(report.issues, [])
  assert.equal(report.ready, true)
})

test('rejects a TypeSafe score outside the unit interval', async () => {
  const report: VerificationReport = {
    ready: true,
    tests: [],
    semanticChecks: [],
    issues: [],
    result: {
      taskId: 'score', task: 't', status: 'done', summary: 's',
      changedFiles: [], testsClaimed: [], blockers: [],
    },
  }
  for (const noul of [9, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      evaluateWithTypeSafe(report, [{ id: 'c', instructions: 'x', threshold: 0.6 }], {
        apiKey: 'k',
        fetchFn: async () => new Response(JSON.stringify({ answers: { c: { noul } } }), { status: 200 }),
      }),
      SemanticResponseError,
      `${String(noul)} must be refused rather than scored`,
    )
  }
})

test('accepts a score inside the unit interval', async () => {
  const report: VerificationReport = {
    ready: true,
    tests: [],
    semanticChecks: [],
    issues: [],
    result: {
      taskId: 'score', task: 't', status: 'done', summary: 's',
      changedFiles: [], testsClaimed: [], blockers: [],
    },
  }
  const checks = await evaluateWithTypeSafe(report, [{ id: 'c', instructions: 'x', threshold: 0.6 }], {
    apiKey: 'k',
    fetchFn: async () => new Response(JSON.stringify({ answers: { c: { noul: 0.75 } } }), { status: 200 }),
  })
  assert.deepEqual(checks, [{ id: 'c', score: 0.75, threshold: 0.6, passed: true }])
})

test('refuses a claim that omits a file the workspace reports as changed', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'src', 'real.ts'), 'export const a = 2\n')
  // Changed, and deliberately left out of the claim: true as far as it goes,
  // misleading about the whole.
  await writeFile(join(repo, 'src', 'hidden.ts'), 'export {}\n')

  const report = await verifyTaskResult(claim(), { workspaceRoot: repo })
  assert.equal(report.ready, false)
  assert.ok(
    report.issues.some(issue => issue.code === 'UNDECLARED_CHANGE' && issue.message.includes('hidden.ts')),
    'the omission must be named',
  )
})

test('accepts a claim that accounts for every changed file', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'src', 'real.ts'), 'export const a = 2\n')
  const report = await verifyTaskResult(claim(), { workspaceRoot: repo })
  assert.deepEqual(report.issues, [])
  assert.equal(report.ready, true)
})

test('can be told to tolerate undeclared changes', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'src', 'real.ts'), 'export const a = 2\n')
  await writeFile(join(repo, 'src', 'hidden.ts'), 'export {}\n')

  const report = await verifyTaskResult(claim(), { workspaceRoot: repo, verifyComplete: false })
  assert.deepEqual(report.issues, [])
})

test('binds the verdict to a fingerprint that moves when the tree does', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'src', 'real.ts'), 'export const a = 2\n')
  const first = await verifyTaskResult(claim(), { workspaceRoot: repo })
  assert.equal(typeof first.workspaceDigest, 'string')

  // A verdict is only meaningful for the tree it was taken against, so a later
  // edit must produce a different fingerprint — otherwise a stale pass is
  // indistinguishable from a fresh one.
  await writeFile(join(repo, 'src', 'real.ts'), 'export const a = 3\n')
  const second = await verifyTaskResult(claim(), { workspaceRoot: repo })
  assert.notEqual(first.workspaceDigest, second.workspaceDigest)
})

test('records no fingerprint outside a work tree', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'typesafe-nodigest-'))
  await writeFile(join(plain, 'real.ts'), 'export {}\n')
  const report = await verifyTaskResult(claim({ changedFiles: ['real.ts'] }), { workspaceRoot: plain })
  assert.equal(report.workspaceDigest, undefined)
})

test('the fingerprint is stable while the tree is', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'src', 'real.ts'), 'export const a = 2\n')

  // Two failure modes were observed here and both defeat staleness detection:
  // hashing `git stash create`'s commit, which carries a timestamp and so
  // changed on every call, and running the git invocations concurrently, which
  // lost the index-lock race and produced no fingerprint at all. A digest that
  // varies or vanishes cannot distinguish a stale pass from a fresh one.
  const digests: Array<string | undefined> = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    digests.push((await verifyTaskResult(claim(), { workspaceRoot: repo })).workspaceDigest)
  }
  assert.equal(new Set(digests).size, 1, 'an unchanged tree must yield one fingerprint')
  assert.notEqual(digests[0], undefined)
})
