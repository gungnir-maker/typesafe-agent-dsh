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

/** Wall-clock bound for one git invocation. */
const defaultGitTimeoutMs = 10_000

/** One git invocation's outcome. */
type GitResult = { ok: true; stdout: string } | { ok: false }

/** What the work tree says about the claimed paths. */
export type ChangeSet = {
  /** Paths that differ from `HEAD`: modified, staged, untracked, or deleted. */
  changed: Set<string>
  /**
   * Paths git reports as removed. A deletion is a real change whose file is
   * legitimately absent, so the caller must not demand it exist.
   */
  deleted: Set<string>
}

/** Bounds applied to every git invocation. */
export type GitOptions = {
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Per-invocation deadline; a wedged git must not wedge verification. */
  timeoutMs?: number
}

/**
 * Run one git command, treating a missing binary, a non-zero exit, a spawn
 * error, a deadline, and a cancellation alike as "could not answer".
 * @param args - git arguments, excluding the program name.
 * @param cwd - directory to run in; also the base for relative pathspecs.
 * @param options - cancellation and deadline.
 * @returns the captured stdout, or a failure marker.
 */
function git(args: readonly string[], cwd: string, options: GitOptions): Promise<GitResult> {
  return new Promise((done) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined

    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort)
      done(result)
    }

    let child
    try {
      child = spawn('git', args, {
        cwd,
        // Own process group, like the verification commands: a git that wedges
        // on a network mount must be killable as a whole.
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      finish({ ok: false })
      return
    }

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < outputLimit) stdout += chunk.toString()
    })

    const killGroup = (): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone; `close` owns settlement.
        }
      }
    }

    onAbort = (): void => { killGroup(); finish({ ok: false }) }
    timer = setTimeout(() => { killGroup(); finish({ ok: false }) }, options.timeoutMs ?? defaultGitTimeoutMs)

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', () => finish({ ok: false }))
    child.on('close', (code) => { finish(code === 0 ? { ok: true, stdout } : { ok: false }) })
  })
}

/** Split NUL-separated porcelain output, which never quotes or escapes a path. */
function split0(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0)
}

/**
 * Whether `root` sits inside a git work tree.
 * @param root - directory to test.
 * @param options - cancellation and deadline.
 * @returns true when git answers yes.
 */
export async function isGitWorkTree(root: string, options: GitOptions = {}): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], root, options)
  return result.ok && result.stdout.trim() === 'true'
}

/**
 * The claimed paths that differ from `HEAD`.
 *
 * Paths are matched as given, so callers pass them relative to `root`, which is
 * also where git runs.
 * @param root - workspace root.
 * @param paths - claimed paths, relative to `root`.
 * @param options - cancellation and deadline.
 * @returns the change set, or `undefined` when git cannot answer — not inside a
 * work tree, no commits yet, or git unavailable.
 */
export async function changedFiles(
  root: string,
  paths: readonly string[],
  options: GitOptions = {},
): Promise<ChangeSet | undefined> {
  if (paths.length === 0) return { changed: new Set(), deleted: new Set() }
  if (!await isGitWorkTree(root, options)) return undefined

  // Three questions, because none alone covers the surface: `diff HEAD` sees
  // edits to tracked files including staged ones, `ls-files --others` sees files
  // created and never added, and `--diff-filter=D` sees removals, whose paths
  // are legitimately absent from disk. `--relative` keeps every answer relative
  // to `root`, matching the claimed paths as written.
  const [modified, untracked, deleted] = await Promise.all([
    git(['diff', '--name-only', '-z', '--relative', 'HEAD', '--', ...paths], root, options),
    git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], root, options),
    git(['diff', '--name-only', '-z', '--relative', '--diff-filter=D', 'HEAD', '--', ...paths], root, options),
  ])
  if (!modified.ok || !untracked.ok || !deleted.ok) return undefined

  const removed = new Set(split0(deleted.stdout))
  return {
    changed: new Set([...split0(modified.stdout), ...split0(untracked.stdout), ...removed]),
    deleted: removed,
  }
}
