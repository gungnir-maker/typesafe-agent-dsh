import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import {
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

function runCommand(command: string, cwd: string): Promise<TestEvidence> {
  return new Promise((done) => {
    const child = spawn('/bin/sh', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => {
      if (output.length < outputLimit) output += chunk.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => done({ command, passed: false, output: error.message }))
    child.on('close', (code) => done({ command, passed: code === 0, output: output.slice(0, outputLimit) }))
  })
}

export async function verifyTaskResult(rawResult: string, options: VerifyOptions): Promise<VerificationReport> {
  const issues: VerificationIssue[] = []
  let parsed: unknown

  try {
    parsed = JSON.parse(rawResult)
  } catch {
    return { ready: false, tests: [], issues: [{ code: 'INVALID_RESULT', message: 'Result is not valid JSON.' }] }
  }

  const result = taskResultSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ready: false,
      tests: [],
      issues: [{ code: 'INVALID_RESULT', message: result.error.issues.map((issue) => issue.message).join('; ') }],
    }
  }

  const root = resolve(options.workspaceRoot)
  const prefixes = options.allowedPathPrefixes ?? []
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
    if (!await fileExists(fullPath)) issues.push({ code: 'MISSING_FILE', message: `Changed file does not exist: ${changedFile}` })
  }

  const tests: TestEvidence[] = []
  for (const command of options.verificationCommands ?? []) {
    if (!result.data.testsClaimed.includes(command)) {
      issues.push({ code: 'TEST_NOT_DECLARED', message: `Agent did not claim required test: ${command}` })
      continue
    }
    const evidence = await runCommand(command, root)
    tests.push(evidence)
    if (!evidence.passed) issues.push({ code: 'TEST_FAILED', message: `Required test failed: ${command}` })
  }

  return {
    ready: result.data.status === 'done' && issues.length === 0,
    result: result.data,
    tests,
    issues,
  }
}

export function parseTaskResult(rawResult: string): TaskResult {
  return taskResultSchema.parse(JSON.parse(rawResult))
}
