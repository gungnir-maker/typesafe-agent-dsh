# Security

This plugin runs shell commands, reads credentials, and sends task evidence to a third-party API. That combination deserves a precise statement of what it can reach, so this document describes the actual boundary rather than a generic policy.

## Threat model

The plugin treats its **configuration as the trust boundary**. `verificationCommands` and `allowedPathPrefixes` are package configuration, written by whoever installs the plugin — never model input. The model can request only what that configuration already permits.

## What the plugin can do

| Capability | Bounded by |
|---|---|
| Run shell commands | Only the exact strings in `verificationCommands`, each executed as `/bin/sh -lc <command>` in its own process group, with the working directory set to `workspaceRoot`, and killed when it exceeds `commandTimeoutMs` |
| Inspect claimed files | Inside `workspaceRoot` and the listed `allowedPathPrefixes`, and — inside a git work tree — confirmed to differ from `HEAD` |
| Invoke git | `rev-parse`, `diff --name-only`, and `ls-files --others`, in `workspaceRoot`, to answer whether a claimed file actually changed |
| Resolve one credential | Only the reference named by `typesafe.apiKeyEnv` (default `TYPESAFE_API_KEY`) |
| Send evidence to TypeSafe AI | Only when the `typesafe` gate is configured |

## What the plugin cannot do

- **Run a command the config does not list.** A model-supplied command never reaches a shell. A command the agent did not declare in `testsClaimed` is reported as `TEST_NOT_DECLARED` and not executed.
- **Read file contents.** The file policy calls `access()`; the git checks read path name listings, not file bodies. Reading a file's bytes is not a capability this plugin has.
- **Escape the workspace.** Paths resolving outside `workspaceRoot`, or outside `allowedPathPrefixes`, are refused as `PATH_OUTSIDE_WORKSPACE` before any check touches them.
- **Write anything.** This package contains no filesystem write path. The browser half writes one credential, and only through the Harness credential service.
- **Return the key to the browser.** The card learns `configured` and `writable` from `credentials.describe`; the literal crosses the wire in one direction only.
- **Run a command forever.** Each is bounded by `commandTimeoutMs` (default five minutes) and by the caller's cancellation, and its whole process group is killed on either. Detached groups can outlive a crashed host, which is the price of a kill that reaches grandchildren.

## What this still does not prove

The change check is relative to `HEAD`, so it cannot tell a change you made from one that was already uncommitted when you started; run it on a clean tree if that distinction matters. And a passing suite is not coverage: the plugin confirms the command you configured exits zero, never that it exercises the task at hand.

## Data egress — read this before enabling the gate

When `typesafe` is configured, each verification sends a JSON payload to `https://api.typesafe.ai/v1/systemone` containing:

- the task text,
- the completion result (`taskId`, `task`, `summary`, `changedFiles`, `testsClaimed`, `blockers`),
- and **the captured output of every configured verification command**, truncated to 8000 characters per result.

That last item is the one to think about. Test and build output routinely echoes environment variables, connection strings, absolute paths, and occasionally tokens. **Enabling the semantic gate sends that output to a third party.**

If your test output can contain secrets, either leave the `typesafe` block unconfigured (deterministic verification needs no key and no network) or change `verificationCommands` to something whose output you are willing to export.

The API key itself travels only in the `Authorization: Bearer` header.

## A configured gate fails closed

If `typesafe` is configured but no key resolves, the plugin marks **every otherwise-passing task** `ready: false` with `TYPESAFE_UNAVAILABLE` rather than silently skipping the check. Configure the gate only once a key is available, or verification will appear permanently broken.

## Installation trust

Installing this package lets it execute its own build at install time under two of the three distribution forms:

- **npm or a tarball** — prebuilt; no build script runs on the user's machine.
- **git (`github:…`)** — the `prepare` script runs at install time. pnpm ≥10 additionally requires an explicit `allowBuilds` entry, which is permission to execute the package's code on your machine. Pin a commit (`github:gungnir-maker/typesafe-agent-dsh#<sha>`) so a later push cannot change what runs.

## Reporting

Open an issue at <https://github.com/gungnir-maker/typesafe-agent-dsh/issues>. For a vulnerability, describe the impact and a reproduction; please avoid publishing a working exploit before a fix ships.
