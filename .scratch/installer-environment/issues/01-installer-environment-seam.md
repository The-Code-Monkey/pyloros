# 01 - Installer environment seam

Status: ready-for-agent

## Goal

Introduce the Installer module and its explicit environment without changing behaviour.

## Context

- Spec: `.scratch/installer-environment/spec.md`
- Current orchestrator: `src/install/install.ts`
- Materialize interface: `src/store/materialize.ts`

## Acceptance

- An Installer environment carries registry, advisory provider, provenance verifier, sandbox runner, Store, platform, clock, concurrency, script timeout, allow-advisories switch, and Fallback Selector.
- An Installer is created from that environment and exposes one install operation taking a frozen, resolve, or re-resolve intent.
- Preferred versions live on the intent, not in process-wide state.
- The existing frozen/resolve/re-resolve flow, drift checks, lockfile writes, Gate persistence, and result shape move behind the Installer interface.
- A temporary compatibility wrapper may keep existing callers working, but the Installer seam must be directly testable with fake adapters.
- No behaviour change; all existing tests remain green.

## Comments
