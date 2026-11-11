# Platform filtering, Store materialization, and atomic swap

Status: implemented
Recorded: 2026-11-11

## Problem Statement

A resolved and locked tree is not yet an installed tree. The user needs Pyloros to put the exact pinned packages into a flat `node_modules`, choose only the Platform Variants that can run on this machine, reuse verified content from the Store, and never leave a partially written tree if the install is interrupted.

## Solution

Pyloros materializes a flat `node_modules` from the Store. Each package's extracted contents are hardlinked, reflinked, or copied into a staging directory, with the common archive root removed. Packages whose `os`, `cpu`, or `libc` constraints do not match the host are skipped and reported. A root dependency that cannot run on the host is a hard error.

The staged tree is completed and stamped with a state marker before it replaces the previous `node_modules` in one atomic swap. If anything fails, the previous tree stays intact. If a crash interrupts the swap, the next run restores the previous tree.

## User Stories

1. As a Pyloros user, I want a flat `node_modules`, so that the single-version Clean Resolution Set maps directly to disk.
2. As a Pyloros user, I want unscoped packages installed at their name, so that Node resolution works normally.
3. As a Pyloros user, I want scoped packages installed under their scope directory, so that aliases and imports resolve.
4. As a Pyloros user, I want the common archive root directory stripped, so that package files sit directly under the package directory.
5. As a Pyloros user, I want only packages matching my operating system installed, so that foreign binaries are not placed in the tree.
6. As a Pyloros user, I want only packages matching my CPU architecture installed, so that native artifacts are correct.
7. As a Pyloros user, I want libc constraints respected, so that glibc and musl variants are not confused.
8. As a Pyloros user, I want negated platform entries honored, so that npm-style exclusion ranges work.
9. As a Pyloros user, I want a wildcard platform entry to match everything, so that packages declaring compatibility broadly still install.
10. As a Pyloros user, I want an unknown host libc to fail closed when a package constrains libc, so that a wrong binary is not installed.
11. As a Pyloros user, I want a platform-mismatched root dependency to fail with the Runtime Contract code, so that an unusable required package is caught immediately.
12. As a Pyloros user, I want platform-mismatched transitive variants skipped rather than failing the whole install, so that optional binary packages do not block work.
13. As a Pyloros user, I want skipped variants reported, so that I know what was left out.
14. As a Pyloros user, I want verified content reused from the Store, so that repeated installs avoid needless work.
15. As a Pyloros user, I want files hardlinked from the Store when possible, so that disk use stays low.
16. As a Pyloros user, I want a reflink or copy fallback when hardlinks are impossible, so that cross-device and restricted filesystems still work.
17. As a Pyloros user, I want a bounded number of concurrent downloads and extractions, so that installs use resources predictably.
18. As a Pyloros user, I want all work done in a staging directory, so that the previous tree is never edited in place.
19. As a Pyloros user, I want the staged tree swapped into place atomically, so that readers never see a half-written tree.
20. As a Pyloros user, I want a state marker inside `node_modules` describing what was installed, so that the tree explains itself.
21. As a Pyloros user, I want a failed install to preserve the previous `node_modules`, so that a broken install cannot destroy a working setup.
22. As a Pyloros user, I want a crash during the swap recovered on the next run, so that a missing `node_modules` is restored from the previous tree.
23. As a Pyloros user, I want stale staging directories cleaned up, so that aborted runs do not accumulate junk.
24. As a Pyloros user, I want install results deterministic, so that the same lockfile produces the same installed list.
25. As a Pyloros user, I want non-regular files refused during materialization, so that a corrupted Store entry cannot expand into device nodes or links.
26. As a Pyloros user, I want the real application to run after install, so that materialization is proven end to end.
27. As a maintainer, I want the materializer to depend on a tarball source interface, so that tests inject fixture tarballs.

## Implementation Decisions

- Platform matching uses operating system, CPU, and libc constraints. Lists may contain positives, negatives prefixed with `!`, and the `*` wildcard. A negated match wins. Positive-only lists require membership.
- The current platform is derived from the Node process. On Linux, libc is detected from the runtime report: a glibc version string means glibc, absence means musl. Other platforms have no libc constraint.
- If a package constrains libc but the host libc is unknown, the package does not match. This is fail-closed.
- Root dependency identities are checked before materialization. A root dependency whose Platform Variant does not match is a Runtime Contract error. Transitive mismatches are skipped.
- Package records are materialized from the lockfile alone. Each record is converted into the registry manifest shape expected by the tarball source, using the recorded resolved URL and integrity.
- The Store is the verified content source. Tarballs are downloaded and verified through the registry client, stored content-addressed, and extracted before linking.
- The common package root is detected as a single non-hidden top-level directory. Otherwise the extracted directory itself is used.
- File linking tries a hardlink first and falls back to a reflink-or-copy for cross-device, permission, link-count, or unsupported-file-system errors. Directory modes are normalized; archive file modes are not trusted.
- Non-regular files are refused during materialization as a defense-in-depth measure even though the tar reader already rejects them.
- Downloads and extractions run with bounded concurrency, currently eight.
- Materialization happens in a hidden staging directory at the project root. Package directories are created under their full scoped path.
- A state directory inside the staged tree records the tool, Node version and ABI, install timestamp, installed package identities, and skipped package identities.
- The swap renames the existing `node_modules` to a hidden previous directory, renames the staging directory to `node_modules`, then deletes the previous directory. If the second rename fails, the previous directory is restored.
- Recovery runs before each materialization. If `node_modules` is absent and a previous directory exists, the most recently modified previous directory is restored. Stale staging directories are deleted.
- The materializer takes the project directory, lockfile, tarball source, Store, platform, concurrency, and clock as options, and returns the installed directory, installed identities, and skipped identities.
- The materializer does not resolve, check advisories, write lockfiles, or execute scripts.

## Testing Decisions

- The primary seam is the materializer's public entry point, driven by fixture tarballs and an injected Store in a temporary project. Tests assert the resulting tree, installed and skipped lists, state marker, error types, and preserved previous tree.
- Materialization tests cover flat and scoped layout, root stripping, platform-based skipping, root platform failure, failure preservation, and interrupted-swap recovery with staging cleanup.
- Platform tests cover empty constraints, positives, negations, wildcards, unknown libc fail-closed behaviour, and derivation from the process.
- Content-addressing, integrity, and tar behaviour are covered by the earlier Store stage; this stage reuses that verified content path.
- A real-registry smoke run generates a lockfile for the real-world fixture, materializes it, and runs the fixture application to prove the installed tree works.
- Prior art: temporary project directories, fixture tarballs, injected sources, and filesystem assertions.

## Out of Scope

- Executing lifecycle scripts, provenance verification, and sandboxing; those belong to the Install Gate stage.
- Bin linking and `node_modules/.bin` population.
- Optional-versus-required edge metadata in the lockfile.
- Cache eviction, garbage collection, and Store integrity auditing.
- Cross-process locking for concurrent installs in the same project.
- macOS and Windows platform detection.

## Further Notes

- Bin links are deliberately deferred. Scripts that depend on `.bin` will need that work before they can run reliably.
- The resolver treats optional dependencies as hard constraints, so the lockfile does not record whether an edge was optional. Platform filtering compensates for the common binary-variant case, but richer edge metadata is a future improvement.
- The state marker is a diagnostic and recovery aid, not a substitute for the lockfile.
- Real-world verification used a fixture app depending on commander, kleur, and semver; the app ran successfully after materialization.
