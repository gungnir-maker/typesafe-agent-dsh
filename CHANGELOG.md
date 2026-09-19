# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A changed-file check: each claimed file must differ from `HEAD`, reported as `FILE_NOT_CHANGED` otherwise. Existence alone let a claim name any pre-existing file, which is the cheapest way to overstate a change. Applies only inside a git work tree, where the answer is knowable; elsewhere it is skipped rather than guessed. Configurable with `verifyChanges`.
- `commandTimeoutMs`, bounding each verification command (default five minutes). A run cut short is reported as `TEST_TIMED_OUT` with `timedOut` on its evidence, so a truncated command never reads as a clean one.
- A completion instruction registered through the prompt registry, so the model is told to call `typesafe_verify_task` before reporting a task done. Registering a tool is not the same as getting it called: without this section the gate stays dormant until a human asks for it.
- A TypeSafe card in the Models settings page's footer, entered beside the provider keys and carrying the same configured/missing dot. It writes through the existing `ctx.remote.credentials` namespace, so no new Host RPC is introduced.
- `SECURITY.md` stating the trust boundary: the command allowlist, the file policy, the one-way credential flow, and the evidence — including captured command output — that enabling the semantic gate sends to `api.typesafe.ai`.
- A CI workflow running typecheck, tests, a parse check of the hand-written client bundle, and a tarball-contents check on the host's Node matrix.

### Changed

- The shipped default semantic threshold is now `0.6`, matching the documented recommendation it contradicted. It was still `0.8`, so a user who enabled `typesafe` without writing out explicit `checks` received the strict value that refuses honest work — the measurement and the default disagreed, and only one of them was visible in the README. The default and the fallback for a check naming no threshold are now pinned by a test.
- The TypeSafe key now resolves through the Harness credential service (`ctx.credentials.resolve`) before falling back to `process.env`. The service layers the writable store over `.env` files and the inherited environment, so a key entered on the Models page reaches the next `typesafe_verify_task` call with no restart. Previously only `process.env` was read, which no configuration surface can write.
- `TYPESAFE_UNAVAILABLE` now names the unresolved reference rather than assuming the default one.
- Declared `author`, `repository`, `homepage`, `bugs`, and `engines`. The engine range matches the Harness host's own constraint.

### Fixed

- A false completion returned `ready: true`. The blockers field was parsed and then never read, so `{"status":"done","blockers":["Still broken"]}` passed; and a claim with no changed files and no executed command satisfied every rule vacuously. Now reported as `BLOCKERS_REPORTED` and `NO_EVIDENCE`.
- The allowed-prefix policy was bypassable. `src/../outside.txt` starts with `src/`, so an unnarrowed prefix test accepted a path that resolves outside the allowed area, and a symlink inside the workspace pointing outside it passed both the lexical and the existence test. Claims are now normalized before comparison, refused when absolute or still holding a `..`, and checked against `realpath`.
- A legitimate deletion failed verification: the removed file does not exist, so the existence check rejected a real change. Git's deletion set is now consulted, and a removed path is accepted as a change instead of a missing file.
- A malformed semantic response was scored as a pass. Nothing validated the range, so a Noul value of `9` cleared every threshold. Scores must now be finite and inside `[0, 1]`, reported as `SEMANTIC_RESPONSE_INVALID` rather than laundered into a verdict.
- A credential-service exception escaped the tool: `resolveApiKey` was called outside the handler around the semantic gate, so a provider whose backing store was unreadable produced an unhandled throw instead of a report. Both TypeSafe and the git checks are now bounded by a deadline and honour caller cancellation.
- A verification command that never returned wedged the tool call indefinitely. Nothing bounded it, the tool declared no `timeoutMs`, and `execute` never took `exec`, so the caller's cancellation was not even observed. Commands are now bounded, killed by process group on expiry or abort, and reported as `TEST_TIMED_OUT`.
- A git-hosted install loaded nothing: `dist/` is gitignored while `main` and `exports` resolve into it, and a clone has no build output. A `prepare` script now builds on install. pnpm additionally requires the build to be allowlisted.
- The MIT notice shipped as a bare `Copyright (c) 2026`, naming no licensor; it now names the holder.

## [0.1.0] - 2026-09-19

### Added

- Initial release: one completion contract, file-boundary checks, trusted verification-command reruns, and an optional TypeSafe semantic gate.
