import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { posix, relative, resolve, sep } from 'node:path'
import { changedFiles, workspaceDigest, worktreeChanges, type ChangeSet } from './changed.js'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  taskResultSchema,
  type TaskResult,
  type TestEvidence,
  type VerificationIssue,
  type VerificationReport,
  type VerifyOptions,
} from './contracts.js'

const outputLimit = 8_000

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`..${sep}`)
}

function isAllowed(path: string, prefixes: string[]): boolean {
  return prefixes.length === 0 || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * Reduce a claimed path to the form the policy is written against.
 *
 * A claim is attacker-controlled input, so it is normalized *before* it is
 * compared to anything. `src/../outside.txt` is not a path under `src`, but it
 * starts with `src/`, so an unnarrowed prefix test accepts it while the
 * resolved file sits outside the allowed area. Normalizing first collapses the
 * traversal; anything that survives with a leading `..`, or that names an
 * absolute path, is refused outright.
 * @param claimed - the path as the agent wrote it.
 * @returns the normalized relative path, or `undefined` when it is not one.
 */
function normalizeClaim(claimed: string): string | undefined {
  const slashed = claimed.split(sep).join('/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return undefined
  const normalized = posix.normalize(slashed)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return undefined
  }
  return normalized
}

/** Bound one verification command's execution. */
interface CommandLimits {
  /** Wall-clock budget in milliseconds. */
  timeoutMs: number
  /** Caller cancellation, forwarded to the child's process group. */
  signal?: AbortSignal
}

/**
 * Run one verification command under a wall-clock bound.
 *
 * Bounded deliberately. An unbounded command that never returns never settles
 * this promise, which wedges the tool call instead of failing it — a worse
 * outcome than a wrong verdict, because there is nothing to report.
 *
 * Spawned detached so the kill can reach the whole process group. Killing only
 * the shell leaves a test runner alive holding the pipes, so no `close` ever
 * arrives and the timeout achieves nothing. The trade is that a command
 * outlives a crashed host; the alternative is a timeout that does not work.
 * @param command - the configured command string.
 * @param cwd - workspace root.
 * @param limits - timeout and cancellation.
 * @returns the command's evidence, with `timedOut` set when it was cut short.
 */
function runCommand(command: string, cwd: string, limits: CommandLimits): Promise<TestEvidence> {
  return new Promise((done) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined

    const finish = (evidence: TestEvidence): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) limits.signal?.removeEventListener('abort', onAbort)
      done(evidence)
    }

    const child = spawn('/bin/sh', ['-lc', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      if (output.length < outputLimit) output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

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

    const cut = (reason: string): void => {
      killGroup()
      finish({ command, passed: false, timedOut: true, output: `${output.slice(0, outputLimit)}\n${reason}` })
    }

    onAbort = (): void => { cut('[cancelled by caller]') }
    timer = setTimeout(() => { cut(`[timed out after ${limits.timeoutMs}ms; process group killed]`) }, limits.timeoutMs)

    if (limits.signal !== undefined) {
      if (limits.signal.aborted) {
        onAbort()
        return
      }
      limits.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => { finish({ command, passed: false, output: error.message }) })
    child.on('close', (code) => { finish({ command, passed: code === 0, output: output.slice(0, outputLimit) }) })
  })
}

export async function verifyTaskResult(rawResult: string, options: VerifyOptions): Promise<VerificationReport> {
  const issues: VerificationIssue[] = []
  let parsed: unknown

  try {
    parsed = JSON.parse(rawResult)
  } catch {
    return { ready: false, tests: [], semanticChecks: [], issues: [{ code: 'INVALID_RESULT', message: 'Result is not valid JSON.' }] }
  }

  const result = taskResultSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ready: false,
      tests: [],
      semanticChecks: [],
      issues: [{ code: 'INVALID_RESULT', message: result.error.issues.map((issue) => issue.message).join('; ') }],
    }
  }

  // A `done` claim that reports its own blockers is not done. The field was
  // parsed and then never read, so `{"status":"done","blockers":["Still
  // broken"]}` returned ready.
  if (result.data.status === 'done' && result.data.blockers.length > 0) {
    issues.push({
      code: 'BLOCKERS_REPORTED',
      message: `A done claim reports unresolved blockers: ${result.data.blockers.join('; ')}`,
    })
  }

  const root = resolve(options.workspaceRoot)
  const prefixes = options.allowedPathPrefixes ?? []
  const gitOptions = {
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs },
  }

  // Collection failures are named, never skipped. `verifyChanges` defaults to
  // requiring these answers, and a check that quietly does not run is how a
  // gate reports success for having verified nothing — the exact failure this
  // plugin exists to catch. A missing answer is `unverified`, not `pass`.
  const requireChanges = options.verifyChanges !== false
  const uncollected: string[] = []
  const changeSet: ChangeSet | undefined = requireChanges
    ? await changedFiles(root, result.data.changedFiles, gitOptions)
    : undefined
  if (requireChanges && changeSet === undefined) uncollected.push('the workspace change set')
  // Symlinks are followed, so containment is judged on the real path. Without
  // this, a symlink inside the workspace pointing outside it passes both the
  // lexical workspace test and the existence test.
  const realRoot = await realpath(root).catch(() => root)

  for (const claimed of result.data.changedFiles) {
    const changedFile = normalizeClaim(claimed)
    if (changedFile === undefined) {
      issues.push({ code: 'PATH_OUTSIDE_WORKSPACE', message: `Changed file is not a relative path inside the workspace: ${claimed}` })
      continue
    }
    const fullPath = resolve(root, changedFile)
    if (!isInside(root, fullPath)) {
      issues.push({ code: 'PATH_OUTSIDE_WORKSPACE', message: `Changed file is outside workspace: ${claimed}` })
      continue
    }
    if (!isAllowed(changedFile, prefixes)) {
      issues.push({ code: 'PATH_OUTSIDE_WORKSPACE', message: `Changed file is outside allowed paths: ${claimed}` })
      continue
    }

    const realFilePath = await realpath(fullPath).catch(() => undefined)
    // A deletion is a real change whose file is legitimately gone, so a missing
    // path is only a defect when the tree does not account for it.
    const deleted = changeSet?.deleted.has(changedFile) === true
    if (realFilePath === undefined) {
      if (!deleted) issues.push({ code: 'MISSING_FILE', message: `Changed file does not exist: ${claimed}` })
    } else if (!isInside(realRoot, realFilePath)) {
      issues.push({ code: 'PATH_OUTSIDE_WORKSPACE', message: `Changed file resolves outside the workspace: ${claimed}` })
      continue
    }

    if (changeSet !== undefined && !changeSet.changed.has(changedFile)) {
      issues.push({ code: 'FILE_NOT_CHANGED', message: `Changed file is unmodified relative to HEAD: ${claimed}` })
    }
  }

  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const tests: TestEvidence[] = []
  for (const command of options.verificationCommands ?? []) {
    if (!result.data.testsClaimed.includes(command)) {
      issues.push({ code: 'TEST_NOT_DECLARED', message: `Agent did not claim required test: ${command}` })
      continue
    }
    const evidence = await runCommand(command, root, { timeoutMs, ...options.signal === undefined ? {} : { signal: options.signal } })
    tests.push(evidence)
    if (evidence.timedOut === true) {
      issues.push({ code: 'TEST_TIMED_OUT', message: `Required test exceeded ${timeoutMs}ms and was killed: ${command}` })
    } else if (!evidence.passed) {
      issues.push({ code: 'TEST_FAILED', message: `Required test failed: ${command}` })
    }
  }

  // The change set is compared against the claim, not the other way round. A
  // completion that names the files it wants judged and stays silent about the
  // rest is true as far as it goes and misleading about the whole, which is
  // exactly the shape a self-reported claim is most likely to take.
  if (options.verifyComplete !== false && changeSet !== undefined) {
    const whole = await worktreeChanges(root, gitOptions)
    if (whole === undefined) {
      uncollected.push('the full change set')
    } else {
      const declared = new Set<string>()
      for (const claimed of result.data.changedFiles) {
        const normalized = normalizeClaim(claimed)
        if (normalized !== undefined) declared.add(normalized)
      }
      for (const path of [...whole.changed].sort()) {
        if (!declared.has(path)) {
          issues.push({ code: 'UNDECLARED_CHANGE', message: `Workspace change absent from changedFiles: ${path}` })
        }
      }
    }
  }

  // `ready` must mean something was actually checked. A `done` claim with no
  // changed files and no executed command satisfied every rule vacuously and
  // reported success, so the emptiness is now named rather than passing.
  if (result.data.status === 'done' && result.data.changedFiles.length === 0 && tests.length === 0) {
    issues.push({
      code: 'NO_EVIDENCE',
      message: 'A done claim carries no changed files and no executed verification command, so nothing was verified.',
    })
  }

  const digest = await workspaceDigest(root, gitOptions)
  if (requireChanges && digest === undefined) uncollected.push('the workspace fingerprint')

  if (uncollected.length > 0) {
    issues.push({
      code: 'UNVERIFIED',
      message: `Could not determine ${uncollected.join(' or ')} — not a git work tree, no commits yet, or git unavailable — so this claim is unverified. Set verifyChanges: false to accept file-existence checks alone.`,
    })
  }

  return {
    ready: result.data.status === 'done' && issues.length === 0,
    result: result.data,
    tests,
    semanticChecks: [],
    issues,
    ...digest === undefined ? {} : { workspaceDigest: digest },
  }
}

export function parseTaskResult(rawResult: string): TaskResult {
  return taskResultSchema.parse(JSON.parse(rawResult))
}
