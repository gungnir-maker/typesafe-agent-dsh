import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { changedFiles, isGitWorkTree } from '../src/changed.js'

/** Run git in a fixture, failing the test loudly if it refuses. */
function gitIn(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' })
}

/**
 * A throwaway repo holding one committed file.
 * @returns the repository path.
 */
async function repoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typesafe-git-'))
  gitIn(dir, ['init', '-q'])
  gitIn(dir, ['config', 'user.email', 'test@example.com'])
  gitIn(dir, ['config', 'user.name', 'Test'])
  await writeFile(join(dir, 'committed.ts'), 'export const a = 1\n')
  gitIn(dir, ['add', '.'])
  gitIn(dir, ['commit', '-qm', 'init'])
  return dir
}

test('recognises a work tree and rejects a plain directory', async () => {
  const repo = await repoFixture()
  const plain = await mkdtemp(join(tmpdir(), 'typesafe-plain-'))
  assert.equal(await isGitWorkTree(repo), true)
  assert.equal(await isGitWorkTree(plain), false)
})

test('reports unknown rather than guessing outside a work tree', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'typesafe-plain-'))
  await writeFile(join(plain, 'anything.ts'), 'export {}\n')
  assert.equal(await changedFiles(plain, ['anything.ts']), undefined)
})

test('separates a modified file from an untouched one', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'committed.ts'), 'export const a = 2\n')

  const changed = await changedFiles(repo, ['committed.ts'])
  assert.deepEqual([...(changed?.changed ?? [])], ['committed.ts'])

  // The same file, unmodified, in a fresh repo at the same commit.
  const clean = await repoFixture()
  assert.deepEqual([...(await changedFiles(clean, ['committed.ts']))?.changed ?? []], [])
})

test('counts an untracked file as changed', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'brand-new.ts'), 'export {}\n')
  assert.deepEqual([...(await changedFiles(repo, ['brand-new.ts']))?.changed ?? []], ['brand-new.ts'])
})

test('counts a deletion as changed, and names it as one', async () => {
  const repo = await repoFixture()
  await rm(join(repo, 'committed.ts'))

  const result = await changedFiles(repo, ['committed.ts'])
  // A deletion is a real change whose file is legitimately absent, so it must
  // appear as changed and be distinguishable from a file that never existed.
  assert.equal(result?.changed.has('committed.ts'), true)
  assert.equal(result?.deleted.has('committed.ts'), true)
})

test('does not call an unmodified file deleted', async () => {
  const repo = await repoFixture()
  const result = await changedFiles(repo, ['committed.ts'])
  assert.equal(result?.deleted.has('committed.ts'), false)
})

test('answers only for the paths it was asked about', async () => {
  const repo = await repoFixture()
  await writeFile(join(repo, 'committed.ts'), 'export const a = 2\n')
  await writeFile(join(repo, 'other.ts'), 'export {}\n')

  const result = await changedFiles(repo, ['committed.ts'])
  assert.equal(result?.changed.has('other.ts'), false, 'must not report paths outside the request')
})

test('treats an empty claim as nothing to check', async () => {
  const repo = await repoFixture()
  assert.deepEqual([...(await changedFiles(repo, []))?.changed ?? []], [])
})

test('gives up rather than hanging when cancelled', async () => {
  const repo = await repoFixture()
  const controller = new AbortController()
  controller.abort()
  // git cannot answer once cancelled, so this must resolve to "unknown" — the
  // caller skips the check — and not wedge verification behind a live process.
  assert.equal(await changedFiles(repo, ['committed.ts'], { signal: controller.signal }), undefined)
})
