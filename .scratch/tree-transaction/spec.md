# A Tree Transaction seam inside materialize

Status: implemented
Recorded: 2026-11-11

## Problem Statement

Materialize is deep when seen from the installer, but internally it is a grab bag: platform selection, tarball fetch, Store extraction, linking, Gate dispatch, state marker writing, atomic swap and crash recovery all sit in one module. The swap protocol leaks through an exported recovery function and through tests that know hidden staging and previous-directory names. Testing atomicity requires a full tarball, Store and Gate setup.

## Solution

Introduce a Tree Transaction module. Its interface opens a staged tree for a project, exposes commit and abort, and hides staging names, previous-tree ranking, cleanup and rollback. A separate recovery interface restores an interrupted transaction. Materialize becomes a pipeline over adapters and commits only after the Install Gate succeeds.

## User Stories

1. As a Pyloros user, I want the previous `node_modules` left untouched until the staged tree is complete, so that a failed install cannot destroy a working setup.
2. As a Pyloros user, I want the staged tree to replace the previous tree atomically, so that readers never see a half-written tree.
3. As a Pyloros user, I want a failed commit to restore the previous tree, so that atomicity holds even when the rename fails.
4. As a Pyloros user, I want an aborted transaction to remove its staging directory, so that failed runs do not accumulate junk.
5. As a Pyloros user, I want interrupted swaps recovered on the next run, so that a crash does not leave the project without `node_modules`.
6. As a Pyloros user, I want stale staging directories cleaned up, so that abandoned runs do not consume disk.
7. As a Pyloros user, I want Install Gate scripts to run before commit, so that no script sees or replaces the live tree.
8. As a Pyloros user, I want the state marker written inside the staged tree before commit, so that the installed tree describes itself.
9. As a Pyloros user, I want platform filtering and linking to stay unchanged, so that the deepening is not a behaviour change.
10. As a Pyloros user, I want a Gate failure to abort the transaction, so that the previous tree survives.
11. As a Pyloros user, I want recovery to pick the newest previous tree when several exist, so that the most recent interrupted swap wins.
12. As a Pyloros user, I want recovery to leave an existing `node_modules` alone, so that a completed install is never overwritten.
13. As a Pyloros user, I want commit and abort to be safe to call in error paths, so that cleanup cannot mask the original failure.
14. As a maintainer, I want one Tree Transaction interface, so that atomicity, rollback and recovery have locality.
15. As a maintainer, I want hidden directory naming to stay inside the transaction, so that callers and tests never learn it.
16. As a maintainer, I want materialize to read as a pipeline, so that platform, fetch, link and Gate stages can be understood one at a time.
17. As a maintainer, I want crash and rollback tests without tarballs or Gate, so that atomicity is cheap to verify.
18. As a maintainer, I want one end-to-end materialize test kept, so that the pipeline and transaction still compose.
19. As a maintainer, I want ADR 0003's "scripts before swap" rule encoded in the commit ordering, so that the Gate guarantee is preserved.
20. As a maintainer, I want the recovery interface to be the only exported recovery seam, so that the swap protocol stops leaking.

## Implementation Decisions

- A Tree Transaction module is introduced with an interface that opens a transaction for a project directory and returns a staging path, a commit operation and an abort operation.
- A recovery interface restores an interrupted transaction and cleans stale staging directories. It is the only exported recovery surface.
- The transaction hides previous-directory naming, modification-time ranking, staging naming, cleanup and rollback.
- Commit renames the previous tree aside, renames staging into place, and deletes the previous tree. If the second rename fails, commit restores the previous tree.
- Abort removes the staging directory and is safe to call after partial work.
- Recovery runs before a new transaction. If the live tree is absent and a previous tree exists, the newest previous tree is restored. Stale staging directories are removed.
- Materialize uses the transaction: platform selection, fetch, Store extraction, linking and the state marker write into the staging path. The Install Gate runs against the staged tree. Commit happens only after the Gate report is complete.
- Materialize returns the live directory, installed identities, skipped identities and Gate report as before.
- The transaction never executes scripts, verifies provenance, fetches tarballs or makes platform decisions.
- No behaviour change is intended.

## Testing Decisions

- A good test crosses the Tree Transaction interface with a temporary project and ordinary files. It asserts live-tree contents, staging cleanup, rollback and recovery. It needs no tarballs, Store or Gate.
- Tests cover successful commit, commit failure restoring the previous tree, abort cleanup, interrupted-swap recovery, newest-previous selection, recovery leaving a live tree alone, and stale staging cleanup.
- Materialize tests keep one end-to-end case proving platform filtering, linking, Gate ordering and commit composition.
- Prior art: temporary project directories and filesystem assertions in the existing materialize tests.

## Out of Scope

- Cross-process locking for concurrent installs in one project.
- Changing Store layout, linking strategy or platform filtering.
- Changing Gate planning or sandbox execution.
- Cache eviction and garbage collection.
- Persisting Gate or provenance records into the lockfile.

## Further Notes

- ADR 0003 requires gate completion before swap. Commit-after-Gate is an invariant of this interface, not a caller convention.
- The transaction is one seam. Materialize remains the integration point but stops owning the swap protocol.
