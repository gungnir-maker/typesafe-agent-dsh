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
  code: 'INVALID_RESULT' | 'PATH_OUTSIDE_WORKSPACE' | 'MISSING_FILE' | 'TEST_FAILED' | 'TEST_NOT_DECLARED' | 'TYPESAFE_UNAVAILABLE' | 'SEMANTIC_CHECK_FAILED'
  message: string
}

export type TestEvidence = {
  command: string
  passed: boolean
  output: string
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
}

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
