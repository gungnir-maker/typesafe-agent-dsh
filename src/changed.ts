/**
 * Changed-file detection over a git work tree.
 *
 * `verify.ts` establishes that a claimed file *exists*; that is a different
 * question from whether the agent touched it. Without this, a completion claim
 * naming any pre-existing file passes the file policy — the cheapest way to
 * overstate a change.
 *
 * The check applies only where the answer is knowable. Outside a work tree, and
 * when git cannot answer, this reports "unknown" and the caller skips rather
 * than guessing: a false `FILE_NOT_CHANGED` would be worse than no check.
 *
 * Deliberately its own module so it is testable without the Harness peer
 * dependencies that `index.ts` imports.
 * @module typesafe-agent-dsh/changed
 */

import { spawn } from 'node:child_process'

/** Output cap for one git invocation; these listings are short. */
const outputLimit = 1_000_000

/** One git invocation's outcome. */
type GitResult = { ok: true; stdout: string } | { ok: false }

/**
 * Run one git command, treating a missing binary, a non-zero exit, and a spawn
 * error alike as "could not answer".
 * @param args - git arguments, excluding the program name.
 * @param cwd - directory to run in; also the base for relative pathspecs.
 * @returns the captured stdout, or a failure marker.
 */
function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((done) => {
    let settled = false
    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      done(result)
    }
    let child
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      finish({ ok: false })
      return
    }
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < outputLimit) stdout += chunk.toString()
    })
    child.on('error', () => finish({ ok: false }))
    child.on('close', (code) => {
      finish(code === 0 ? { ok: true, stdout } : { ok: false })
    })
  })
}

/** Split NUL-separated porcelain output, which never quotes or escapes a path. */
function split0(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0)
}

/**
 * Whether `root` sits inside a git work tree.
 * @param root - directory to test.
 * @returns true when git answers yes.
 */
export async function isGitWorkTree(root: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], root)
  return result.ok && result.stdout.trim() === 'true'
}

/**
 * The claimed paths that differ from `HEAD` — modified, staged, or untracked.
 *
 * Paths are matched as given, so callers pass them relative to `root`, which is
 * also where git runs.
 * @param root - workspace root.
 * @param paths - claimed paths, relative to `root`.
 * @returns the subset that differs from `HEAD`, or `undefined` when git cannot
 * answer — not inside a work tree, no commits yet, or git unavailable.
 */
export async function changedFiles(root: string, paths: readonly string[]): Promise<Set<string> | undefined> {
  if (paths.length === 0) return new Set()
  if (!await isGitWorkTree(root)) return undefined

  // Two questions, because neither alone covers the surface: `diff HEAD` sees
  // edits to tracked files including staged ones, and `ls-files --others` sees
  // files that were created and never added. `--relative` keeps both answer
  // sets relative to `root`, matching the claimed paths as written.
  const [modified, untracked] = await Promise.all([
    git(['diff', '--name-only', '-z', '--relative', 'HEAD', '--', ...paths], root),
    git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], root),
  ])
  if (!modified.ok || !untracked.ok) return undefined

  return new Set([...split0(modified.stdout), ...split0(untracked.stdout)])
}
