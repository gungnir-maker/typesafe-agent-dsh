# TypeSafe Agent for DeepSeek Harness

`typesafe-agent-dsh` stops an agent from declaring success with prose alone. It validates a typed completion result, checks claimed files stay inside the workspace **and were actually touched**, independently reruns trusted verification commands under a time bound, and can ask TypeSafe AI whether the completion claim is semantically supported by its evidence.

## What it proves

```text
agent claim → typed JSON validation → path policy → changed-file check → bounded command rerun → TypeSafe semantic gate → ready / needs review
```

`ready: true` means all configured checks passed. Tests remain the hard proof. TypeSafe adds a semantic confidence gate; it does not replace deterministic verification.

Each stage answers a narrower question than it looks like, and knowing which is which is the difference between trusting this and over-trusting it:

| Check | The question it answers | What it does *not* answer |
|---|---|---|
| Typed validation | Is the completion a well-formed claim? | whether it is true |
| Path policy | Is every claimed file inside the workspace and allowed prefixes? | whether it exists |
| Existence | Does each claimed file exist? | whether you touched it |
| Changed-file check | Does each claimed file differ from `HEAD`? | that the change is *yours* rather than pre-existing |
| Command rerun | Does the configured command exit zero, now? | that it covers the task |
| Semantic gate | Does the evidence support the claim? | correctness |

The changed-file check runs only inside a git work tree, where the answer is knowable. Elsewhere it is skipped rather than guessed, because a false refusal is worse than no check.

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
        # Wall-clock bound for one command; it is killed on expiry and reported
        # as TEST_TIMED_OUT. Defaults to 300000 (five minutes).
        commandTimeoutMs: 300000
        # Require each claimed file to differ from HEAD, inside a git work tree.
        # Defaults to true; set false to check existence only.
        verifyChanges: true
        typesafe:
          apiKeyEnv: TYPESAFE_API_KEY
          model: jev-latest
          checks:
            - id: completion_is_supported
              instructions: Based only on the task and evidence, is the completion claim supported well enough to hand off?
              threshold: 0.6
```

The key is never kept in this repository. It resolves once per call, in this order:

1. **The Harness credential service** (`ctx.credentials.resolve`) — the writable store layered over `.env` files and the inherited environment.
2. **`process.env`** — the fallback for a composition that mounts no credential provider, and for loading this package outside the Harness.

`typesafe.apiKeyEnv` names the reference; it defaults to `TYPESAFE_API_KEY`.

Configure `typesafe` only when a key is actually available: a configured gate with an unresolved reference forces `ready: false` on every otherwise-passing task rather than skipping the check.

### Entering the key

The plugin ships a browser half, so the key is entered on the **Models** settings page instead of a terminal. It registers a TypeSafe card in that page's footer extension area (`settings.models.footer`), beside the provider keys and styled like them, with a configured/missing dot.

The card writes through the existing `ctx.remote.credentials` namespace — the same surface the provider key fields use — so a key stored there reaches the very next `typesafe_verify_task` call with no restart. The literal crosses the wire in one direction only: the card learns whether a key is configured, never its value.

Without a browser, either export the key before launching:

```bash
export TYPESAFE_API_KEY="your_typesafe_key"
export DEEPSEEK_API_KEY="your_deepseek_key"
dsh web
```

or put it in `$DSH_HOME/.env`, which does not travel with a repository.

### Browser half layout

```text
client/index.js   shipped closure-factory bundle (window.__ModuleLoader__.load)
cordis.patch.yml  bundle layer that mounts the Host plugin row
```

`client/index.js` is the shipped artifact rather than compiled output: the Harness client-module loader consumes exactly this closure-factory form, and this package carries no client build step. React is a client baseline external; the slot service and the credentials Remote arrive through the injected context.

## Agent flow

1. Ask the DeepSeek Harness agent to make a focused change.
2. The agent edits files and calls normal test tools.
3. The agent calls `typesafe_verify_task` with a completion JSON object.
4. This plugin reruns configured tests and returns a typed verification report.

Step 3 is not left to goodwill. The plugin registers a prompt section telling the model to verify before reporting completion, and to pass a `ready: false` on with its issue codes rather than restating it in softer prose:

> A task that changed files is not finished because the edits look right: it is finished when something other than you says so.

Registering a tool is not the same as getting it called — a gate the model is never told about stays dormant until a human asks, which makes it a suggestion rather than a gate. The instruction is what closes that gap.

Before enabling the gate, read [`SECURITY.md`](./SECURITY.md): the semantic check sends the captured output of your verification commands to a third party, and command output routinely contains more than you expect.

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

## What a report looks like

A truthful claim, with every deterministic check green, can still be refused by the semantic gate. `ready` is the conjunction of all of them:

```json
{
  "ready": false,
  "tests": [{ "command": "npm test", "passed": true, "output": "…ok 9/9…" }],
  "semanticChecks": [
    { "id": "completion_is_supported", "score": 0.79, "threshold": 0.8, "passed": false }
  ],
  "issues": [
    { "code": "SEMANTIC_CHECK_FAILED", "message": "TypeSafe check failed: completion_is_supported (0.79 < 0.8)." }
  ]
}
```

That is the gate working, not failing: the suite passed and the changed files were real, but the claim scored just under the bar. Treat the threshold as a dial rather than a constant — the documented `0.8` is deliberately strict and, measured, refuses true work. [Calibrating the threshold](#calibrating-the-threshold) has the numbers. Tests remain the hard proof; the semantic score is a confidence gate on top.

Two failure modes worth knowing:

- `typesafe` configured but no key resolving fails **every** otherwise-passing task with `TYPESAFE_UNAVAILABLE`, rather than skipping the check. Configure the gate only once a key is available.
- `verificationCommands` are package configuration, never model input, and the agent cannot ask for a command the config does not list — an unclaimed command is reported as `TEST_NOT_DECLARED`.

## Calibrating the threshold

The threshold is the one setting you have to tune, and the score it compares against is not a constant. It measures how well the **evidence** supports the **claim** — not how good the claim is.

Measured on one deployment (DeepSeek Harness, `jev-latest`), across completions that all had a green suite:

| Claim | Evidence | Score |
|---|---|---|
| Key resolution, credential store | `npm test` 9/9 | 0.79 |
| Prompt instruction, self-applying gate | `npm test` 14/14 | 0.77 |
| A new README section | `npm test` 18/18 | 0.61–0.70 |
| A one-line README addition | `npm test` 18/18 | 0.70 |
| Any claim while no command is configured | *none* | 0.48 |

Three things follow.

- The honest band sits around **0.6–0.8**, so the documented default of `0.8` refuses true work. **0.6 is a better starting point**, and it still refuses a claim carrying no evidence at all.
- The same task scored 0.61 and 0.70 on two runs, so a threshold *inside* the band is fragile. Leave margin.
- Documentation changes score near the bottom on purpose. A passing suite says nothing about whether README prose is accurate, so the gate is noticing an evidence/claim mismatch rather than judging quality. Expect doc-heavy work to sit low, and configure `verificationCommands` that actually bear on the claim.

These numbers are one model's judgement on one repository, not a benchmark. Re-measure on your own work rather than trusting them.

## Requirements

Node `^22.19.0 || >=24.0.0` — any 22.x from 22.19.0 upward, or 24.0.0 and later. That range is declared in `engines` in `package.json`, and the package is ESM only, so it loads through `import` rather than `require`.

## Commands

```bash
npm run check
npm test
npm run build
```

## Scope of v0.1

One DSH plugin, one completion contract, file-boundary checks, trusted command verification, and a Models-page card for the optional semantic gate's key. Codex and Claude adapters come after this workflow is stable.
