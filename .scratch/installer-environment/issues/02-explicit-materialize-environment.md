# 02 - Materialize receives its environment explicitly

Status: resolved
Blocked by: 01

## Goal

Remove hidden Store and platform defaults from materialize.

## Context

- Spec: `.scratch/installer-environment/spec.md`
- Installer environment: introduced by ticket 01
- Current materialize defaults: `src/store/materialize.ts`

## Acceptance

- Materialize requires a Store and a platform from its caller.
- Materialize no longer constructs a ContentStore or derives `currentPlatform` when they are absent.
- The Installer passes its environment's Store and platform through.
- Tests cover Store reuse and platform filtering through the Installer seam.
- No behaviour change for production wiring.

## Comments

- 2026-11-11: Merged `feat/installer-02-explicit-materialize` into `integration/installer-environment` as merge commit `748ae0b`. No conflicts; branch was based on the current integration head. Verified in the main worktree: `npm run typecheck` passed, `npm test` passed (156 tests, 154 pass, 2 skipped), `npm run build` passed.
