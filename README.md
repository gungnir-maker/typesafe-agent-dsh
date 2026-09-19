# TypeSafe Agent for DeepSeek Harness

`typesafe-agent-dsh` stops an agent from declaring success with prose alone. It validates a typed completion result, checks claimed files stay inside the workspace, and independently reruns trusted verification commands.

## What it proves

```text
agent claim → typed JSON validation → file policy → configured tests → ready / needs review
```

`ready: true` means all configured checks passed. It does not prove an arbitrary natural-language request was fully satisfied.

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
