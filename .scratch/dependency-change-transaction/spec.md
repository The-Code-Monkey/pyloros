# One Dependency Change transaction for mutating commands

Status: ready-for-agent
Recorded: 2026-11-11

## Problem Statement

`add`, `remove` and `update` each re-encode the same dependency-change transaction: read the manifest, write a provisional manifest, install, rewrite the saved range, patch the lockfile root directly, and roll back on failure. The two rollback paths already differ. Two manifest readers parse the same file. Gate and audit disagree about which scripts count as lifecycle scripts. The user-facing commands are shallow adapters over one missing module.

## Solution

Introduce one dependency-change transaction module. Its interface takes the project directory, a change intent and install options, and returns a change result. It hides manifest snapshotting, provisional writes, install orchestration, saved-range rewriting, lockfile root synchronisation and rollback. Command modules parse intent and render results. One lifecycle-script definition is shared by Gate, audit and why.

## User Stories

1. As a Pyloros user, I want `add name` to resolve the latest dist-tag and save an exact Pin, so that adding a dependency stays simple.
2. As a Pyloros user, I want `add name@range` to resolve the range and save the exact chosen version by default, so that Pin behaviour is consistent.
3. As a Pyloros user, I want `add --range` to save a caret range, so that the opt-out stays available.
4. As a Pyloros user, I want `add` to update the manifest and lockfile together, so that they cannot disagree after success.
5. As a Pyloros user, I want `add` to restore the original manifest when resolution or install fails, so that a failed add leaves no trace.
6. As a Pyloros user, I want `remove` to delete a declared dependency and re-resolve, so that the tree shrinks correctly.
7. As a Pyloros user, I want `remove` to restore the original manifest when the follow-up install fails, so that removal is transactional.
8. As a Pyloros user, I want `remove` to refuse an undeclared dependency, so that mistakes are visible.
9. As a Pyloros user, I want `update` to re-resolve the whole tree when no name is given, so that maintenance is predictable.
10. As a Pyloros user, I want `update name` to preserve other Pins where possible, so that updates stay scoped.
11. As a Pyloros user, I want every change to keep the lockfile root specification block in sync with the manifest, so that the next Frozen Install passes.
12. As a Pyloros user, I want a no-op change to leave the manifest and lockfile byte-stable, so that diffs stay quiet.
13. As a Pyloros user, I want a failed change to persist no Gate or provenance records, so that permissions never describe an install that did not happen.
14. As a Pyloros user, I want `add`, `remove` and `update` to share Runtime Contract and advisory enforcement, so that policy cannot drift between commands.
15. As a Pyloros user, I want command output to report the chosen version and saved specification, so that automation can verify the result.
16. As a Pyloros user, I want JSON output from every mutating command, so that scripts do not parse prose.
17. As a Pyloros user, I want audit and why to agree on which scripts are blocked, so that the security report matches the execution policy.
18. As a maintainer, I want one dependency-change interface, so that add, remove and update cannot diverge.
19. As a maintainer, I want one manifest reader in the command path, so that validation rules cannot diverge between reads.
20. As a maintainer, I want command modules to stay intent parsers and result renderers, so that transaction policy has locality.
21. As a maintainer, I want rollback tested through the transaction interface, so that tests do not need the CLI or an HTTP fixture.
22. As a maintainer, I want one end-to-end command test per operation kept, so that the CLI adapters remain proven.
23. As a maintainer, I want the lifecycle-script definition to live in one module, so that Gate, audit and why share leverage.

## Implementation Decisions

- A dependency-change transaction module is introduced. Its interface accepts the project directory, a change intent, and install environment options, and returns a result containing the operation, chosen version, saved specification, whether the lockfile changed, and the install result.
- The change intent is a discriminated union: add with a package specifier and save mode, remove with a Package Identity, update with an optional Package Identity.
- Save modes are exact and caret. Add defaults to exact; `--range` selects caret.
- The transaction reads the manifest once through the validated manifest interface, snapshots the raw manifest for rollback, applies the provisional dependency edit, runs the install orchestrator, computes the chosen version, rewrites the saved specification, synchronises the lockfile root specification through the lockfile module, and writes atomically.
- Rollback restores the original manifest on any failure after the provisional write. Add and remove use the same rollback path.
- The transaction never mutates lockfile root specifications directly; it uses the lockfile module's public write path.
- Dist-tag resolution for add remains inside the transaction, using the registry adapter.
- The transaction never knows about exit codes or output formatting. It returns results and throws the existing domain errors.
- `add`, `remove` and `update` become command adapters: parse flags, call the transaction, render human or JSON output.
- `install` remains a frozen-or-resolve operation and does not use the dependency-change transaction, because it has no dependency intent.
- A lifecycle-script module owns the canonical set of lifecycle script names. Gate, audit and why import it. Lifecycle means preinstall, install and postinstall.
- Audit reports blocked lifecycle scripts only. Why reports blocked lifecycle scripts only. Both use the shared definition.
- No behaviour change is intended beyond making rollback and lifecycle reporting consistent.

## Testing Decisions

- A good test crosses the dependency-change interface with a temporary project and an injected install adapter, then asserts the manifest, lockfile root, result and rollback. It does not spawn the CLI.
- Tests cover exact add, caret add, dist-tag add, remove, full update, scoped update, undeclared remove, install failure rollback for add and remove, manifest and lockfile root agreement, no-op byte stability, and no Gate persistence on failure.
- The lifecycle-script module is tested once and reused by Gate, audit and why tests.
- Existing spawned-CLI tests remain as end-to-end checks for flags, JSON shapes and exit codes.
- Prior art: temporary project directories, fake registry and install adapters, lockfile round-trip tests, and the existing command integration test.

## Out of Scope

- `--dev`, `--optional`, workspaces and dependency groups other than the current tables.
- Package specifier features beyond exact, range and dist-tag.
- Changing the install orchestrator's frozen, resolve or re-resolve rules.
- Implementing the unused `pins` and `allowAdvisories` policy fields.
- Changing Gate execution or sandbox behaviour.

## Further Notes

- The shared lifecycle definition is deliberately part of this module rather than a separate refactor because audit, why and Gate already disagree.
- If a future command adds another dependency table, the transaction's change intent should grow rather than commands gaining their own logic.
- The transaction is one seam. Commands remain adapters; no per-command seam is introduced.
