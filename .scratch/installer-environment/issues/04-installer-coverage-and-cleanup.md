# 04 - Installer coverage and cleanup

Status: ready-for-agent
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
