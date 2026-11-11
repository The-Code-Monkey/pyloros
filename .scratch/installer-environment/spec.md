# Make the installer environment explicit

Status: ready-for-agent
Recorded: 2026-11-11

## Problem Statement

The install orchestrator constructs its registry, advisory provider, provenance verifier, sandbox, Store, platform, clock and concurrency internally. Its option bag is wide, yet important environment choices are hidden. Tests can inject four adapters but still receive the default Store, platform and concurrency, so Store reuse, platform filtering and concurrency cannot be asserted through the orchestrator. Default adapter selection is policy, but it sits in the module rather than in the CLI adapter.

## Solution

Introduce an Installer module built from one explicit environment. The environment carries the registry, advisory provider, provenance verifier, sandbox runner, Store, platform, clock, concurrency, script timeout and interactive fallback policy. The installer exposes one install operation that takes an intent: frozen, resolve or re-resolve. The CLI adapter constructs the real environment and chooses defaults; tests construct a controlled one.

## User Stories

1. As a maintainer, I want one environment value to describe every external dependency of an install, so that wiring is visible in one place.
2. As a maintainer, I want the installer to accept a Store, so that tests can assert reuse and isolation with a temporary Store.
3. As a maintainer, I want the installer to accept a platform, so that platform filtering is testable without running on that platform.
4. As a maintainer, I want the installer to accept a clock, so that timestamps and advisory freshness are deterministic in tests.
5. As a maintainer, I want the installer to accept a concurrency limit, so that bounded fetch behaviour is testable.
6. As a maintainer, I want the installer to accept adapters rather than construct them, so that network, sandbox and provenance can be faked at one seam.
7. As a maintainer, I want default adapter selection in the CLI adapter, so that production policy does not live inside the orchestrator.
8. As a maintainer, I want the install intent to be explicit, so that frozen, resolve and re-resolve are decided by the caller.
9. As a maintainer, I want the install intent to be a discriminated value, so that impossible combinations are not representable.
10. As a maintainer, I want the installer to return one result shape, so that every command renders the same facts.
11. As a Pyloros user, I want production installs to keep using the public registry by default, so that ADR 0001 is preserved.
12. As a Pyloros user, I want production installs to keep using cosign and bubblewrap by default, so that ADR 0003 is preserved.
13. As a Pyloros user, I want a Frozen Install to remain the default when a lockfile exists, so that installs stay reproducible.
14. As a Pyloros user, I want re-resolution to remain explicit, so that switching versions is deliberate.
15. As a Pyloros user, I want Gate records and provenance persisted only after success, so that failed installs record nothing.
16. As a Pyloros user, I want behavior and exit codes unchanged, so that the deepening is not a breaking change.
17. As a maintainer, I want existing installer tests moved to the explicit environment, so that they keep proving the same behavior.
18. As a maintainer, I want one installer seam, so that commands do not assemble their own environments.
19. As a maintainer, I want materialize to receive Store and platform explicitly, so that it stops selecting hidden defaults.
20. As a maintainer, I want the CLI to remain the only place that reads process-level configuration, so that the library stays portable and testable.

## Implementation Decisions

- An Installer module is created from an environment value. The environment contains the registry adapter, advisory provider, provenance verifier, sandbox runner, Store, platform, clock, concurrency limit, script timeout and interactive fallback policy.
- The installer exposes one install operation taking a discriminated intent: frozen, resolve, or re-resolve. Frozen remains the default choice the CLI makes when a lockfile exists.
- The installer owns the existing flow: read manifest, read lockfile, choose the path, run drift checks, resolve, lockfile creation, materialize, Gate report persistence and lockfile write. This logic is not duplicated in commands.
- Default adapter selection moves to the CLI adapter. The library receives only concrete environment values.
- Materialize receives the Store and platform explicitly instead of constructing defaults when omitted. Any default construction that remains must be documented in the installer environment, not hidden in the materialize implementation.
- The install result retains mode, lockfile, wrote-lockfile, resolution and materialization fields. Gate report persistence behavior is unchanged.
- Preferred versions for scoped updates are part of the intent or the environment passed to the installer, not a hidden global.
- The installer never reads process arguments, prints output or decides exit codes.
- No behaviour change is intended.

## Testing Decisions

- A good test crosses the installer interface with a fake environment and a temporary project. It asserts files, lockfile contents, chosen mode and persisted Gate records.
- Tests cover Store reuse with a temporary Store, platform filtering with an injected platform, deterministic clock behavior, concurrency configuration, frozen resolution, resolve, re-resolve, Gate persistence after success and no persistence after failure.
- Existing installer tests are adapted to construct the environment explicitly rather than relying on hidden defaults.
- CLI adapter tests remain spawned and prove that production defaults are wired.
- Prior art: the existing installer tests, fake registry, fake advisory provider, fake provenance verifier and fake sandbox runner.

## Out of Scope

- Adding a configuration file or new environment variables.
- Changing default registry, cosign, bubblewrap or advisory endpoints.
- Changing install modes, drift rules or Gate policy.
- Workspaces, publish and private registries.
- Cross-process locking and cache eviction.

## Further Notes

- ADR 0001 and ADR 0003 constrain the production defaults. Moving those defaults into the CLI adapter preserves both decisions.
- This candidate is worth exploring rather than strong because it is an interface clarification, not a correctness fix. The hidden Store and platform are the concrete pain.
- The installer environment is one seam. Commands use the installer; they do not gain their own environment seams.
