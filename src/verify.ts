import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import { changedFiles } from './changed.js'
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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
      // Own process group: the only handle that reaches grandchildren.
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

  const root = resolve(options.workspaceRoot)
  const prefixes = options.allowedPathPrefixes ?? []

  // Resolved once, before the per-file loop: one git invocation answers for
  // every claim, and `undefined` means the question is unanswerable here — not
  // that nothing changed.
  const changed = options.verifyChanges === false
    ? undefined
    : await changedFiles(root, result.data.changedFiles)

  for (const changedFile of result.data.changedFiles) {
    const fullPath = resolve(root, changedFile)
    if (!isInside(root, fullPath)) {
      issues.push({ code: 'PATH_OUTSIDE_WORKSPACE', message: `Changed file is outside workspace: ${changedFile}` })
      continue
    }
    if (!isAllowed(changedFile, prefixes)) {
      issues.push({ code: 'PATH_OUTSIDE_WORKSPACE', message: `Changed file is outside allowed paths: ${changedFile}` })
      continue
    }
    if (!await fileExists(fullPath)) {
      issues.push({ code: 'MISSING_FILE', message: `Changed file does not exist: ${changedFile}` })
      continue
    }
    if (changed !== undefined && !changed.has(changedFile)) {
      issues.push({ code: 'FILE_NOT_CHANGED', message: `Changed file is unmodified relative to HEAD: ${changedFile}` })
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

  return {
    ready: result.data.status === 'done' && issues.length === 0,
    result: result.data,
    tests,
    semanticChecks: [],
    issues,
  }
}

export function parseTaskResult(rawResult: string): TaskResult {
  return taskResultSchema.parse(JSON.parse(rawResult))
}
