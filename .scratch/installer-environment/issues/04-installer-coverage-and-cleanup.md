# 04 - Installer coverage and cleanup

Status: resolved
Blocked by: 02, 03

## Goal

Prove the environment seam and finish the migration.

## Context

- Spec: `.scratch/installer-environment/spec.md`
- Installer seam: tickets 01-03
- Existing tests: `test/install.test.ts`, `test/commands.test.ts`

## Acceptance

- Installer tests construct the environment explicitly with a temporary Store, injected platform, fixed clock, and configured concurrency.
- Tests cover frozen install, resolve, re-resolve, preferred versions, Gate persistence on success, no persistence on failure, Store reuse, platform filtering, and deterministic timestamps.
- Existing installer and command tests are migrated to the explicit environment.
- No production code constructs hidden adapters or defaults outside the CLI layer.
- The spec is marked implemented.

## Comments

- 2026-11-11: Merged `feat/installer-04-coverage` into `integration/installer-environment` as merge commit `c615f09`. No conflicts. Verified in the main worktree: `npm run typecheck` passed, `npm test` passed (168 passed, 2 skipped, 0 failed), `npm run build` passed, `npm run self-host` passed.
