# 03 - CLI owns default adapter selection

Status: resolved
Blocked by: 01

## Goal

Move production defaults out of the library and into the CLI adapter.

## Context

- Spec: `.scratch/installer-environment/spec.md`
- Installer environment: introduced by ticket 01
- Commands: `src/commands/`
- Dependency-change transaction: `src/install/dependency-change.ts`

## Acceptance

- The CLI/command layer constructs the production environment: public registry, advisory service, cosign verifier, bubblewrap sandbox, default Store, current platform, clock, and concurrency.
- `install`, `add`, `remove`, and `update` use the constructed Installer rather than hidden defaults.
- The dependency-change transaction receives its install runner rather than creating one with hidden defaults.
- The temporary compatibility wrapper from ticket 01 is removed.
- Production defaults still match ADR 0001 and ADR 0003.
- No behaviour change.

## Comments

- Merged `feat/installer-03-cli-defaults` into `integration/installer-environment` as merge commit `6e2ef71edbe9204327db043cbdf77c2114472211`.
- Merge was conflict-free; ticket 02's explicit materialize Store/platform work and the prerequisite `feat/dependency-change-transaction` work are preserved.
- Verification in the main worktree: `npm run typecheck` passed, `npm test` passed (167 passed, 2 skipped, 0 failed), `npm run build` passed.
