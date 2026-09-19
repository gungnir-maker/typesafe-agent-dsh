import { z } from 'zod'

export const taskStatusSchema = z.enum(['done', 'blocked', 'needs_review'])

export const taskResultSchema = z.object({
  taskId: z.string().min(1),
  task: z.string().min(1),
  status: taskStatusSchema,
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  testsClaimed: z.array(z.string().min(1)),
  blockers: z.array(z.string()).default([]),
}).strict()

export type TaskResult = z.infer<typeof taskResultSchema>

export type VerificationIssue = {
  code:
    | 'INVALID_RESULT'
    | 'PATH_OUTSIDE_WORKSPACE'
    | 'MISSING_FILE'
    | 'FILE_NOT_CHANGED'
    | 'TEST_FAILED'
    | 'TEST_TIMED_OUT'
    | 'TEST_NOT_DECLARED'
    | 'TYPESAFE_UNAVAILABLE'
    | 'SEMANTIC_CHECK_FAILED'
  message: string
}

export type TestEvidence = {
  command: string
  passed: boolean
  output: string
  /** Set when the command was cut short, so a truncated run never reads as a clean one. */
  timedOut?: boolean
}

export type VerificationReport = {
  ready: boolean
  result?: TaskResult
  tests: TestEvidence[]
  semanticChecks: SemanticCheckEvidence[]
  issues: VerificationIssue[]
}

export type VerifyOptions = {
  workspaceRoot: string
  verificationCommands?: string[]
  allowedPathPrefixes?: string[]
  /**
   * Wall-clock bound for one verification command, in milliseconds. Omit for
   * {@link DEFAULT_COMMAND_TIMEOUT_MS}. A command that outlives it is killed and
   * reported as a failure: an unbounded run wedges the tool call, which is
   * worse than a wrong answer.
   */
  commandTimeoutMs?: number
  /**
   * Whether a claimed file must actually differ from `HEAD`. Defaults to true
   * and applies only inside a git work tree, where the answer is knowable;
   * elsewhere the check is skipped rather than guessed.
   */
  verifyChanges?: boolean
  /**
   * Caller cancellation. Forwarded to every verification command, whose whole
   * process group is killed when it aborts, so cancelling the tool call ends
   * the work instead of orphaning it.
   */
  signal?: AbortSignal
}

/** Default per-command bound: generous for a suite, short of a wedged call. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000

export type SemanticCheck = {
  id: string
  instructions: string
  threshold?: number
}

export type SemanticCheckEvidence = {
  id: string
  score: number
  threshold: number
  passed: boolean
}
