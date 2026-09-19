# TypeSafe Agent for DeepSeek Harness

`typesafe-agent-dsh` stops an agent from declaring success with prose alone. It validates a typed completion result, checks claimed files stay inside the workspace, independently reruns trusted verification commands, and can ask TypeSafe AI whether the completion claim is semantically supported by its evidence.

## What it proves

```text
agent claim → typed JSON validation → file policy → configured tests → TypeSafe semantic gate → ready / needs review
```

`ready: true` means all configured checks passed. Tests remain the hard proof. TypeSafe adds a semantic confidence gate; it does not replace deterministic verification.

## Install

Build this package first:

```bash
npm install
npm run build
```

Add it to a DeepSeek Harness profile:

```bash
dsh plugin --profile web add file:/absolute/path/to/typesafe-agent-dsh
```

Configure trusted verification commands in the profile patch. Commands are package configuration, not model input:

```yaml
- insert:
    - id: typesafe-agent-dsh
      name: typesafe-agent-dsh
      config:
        workspaceRoot: /absolute/path/to/project
        allowedPathPrefixes: [src, test]
        verificationCommands: [npm test]
        typesafe:
          apiKeyEnv: TYPESAFE_API_KEY
          model: jev-latest
          checks:
            - id: completion_is_supported
              instructions: Based only on the task and evidence, is the completion claim supported well enough to hand off?
              threshold: 0.8
```

Keep the key out of this repository. Before starting DSH, set it in the same terminal:

```bash
export TYPESAFE_API_KEY="your_typesafe_key"
export DEEPSEEK_API_KEY="your_deepseek_key"
dsh web
```

## Agent flow

1. Ask the DeepSeek Harness agent to make a focused change.
2. The agent edits files and calls normal test tools.
3. The agent calls `typesafe_verify_task` with a completion JSON object.
4. This plugin reruns configured tests and returns a typed verification report.

Example completion JSON:

```json
{
  "taskId": "fix-login-validation",
  "task": "Add email validation before creating a login session and prove the test suite passes.",
  "status": "done",
  "summary": "Added email validation before creating a login session.",
  "changedFiles": ["src/login.ts", "test/login.test.ts"],
  "testsClaimed": ["npm test"],
  "blockers": []
}
```

## Commands

```bash
npm run check
npm test
npm run build
```

## Scope of v0.1

One DSH plugin, one completion contract, file-boundary checks, and trusted command verification. Codex and Claude adapters come after this workflow is stable.
