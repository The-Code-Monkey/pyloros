# CLI commands, install orchestration, and Gate persistence

Status: implemented
Recorded: 2026-11-11

## Problem Statement

Pyloros now has the pieces of a package manager: registry access, single-version resolution, advisory handling, a canonical lockfile, materialization, and an Install Gate. None of that is usable from a terminal. There is no command to resolve a project, install it, add or remove a dependency, update one, audit what is pinned, explain why a version won, or initialize a manifest. Gate decisions are returned from materialization but never persisted, so a later Frozen Install cannot reproduce which scripts were allowed or prove the provenance that was checked.

A user needs one coherent command surface that composes the existing stages, uses the lockfile as the authority, makes Frozen Installs the default, and records Gate and provenance decisions only after a successful install.

## Solution

Pyloros gains a single install orchestrator and a command suite built on it. The orchestrator reads the manifest, decides whether a Frozen Install or a fresh resolution is required, runs resolution and advisory checks when needed, verifies drift, materializes the tree, runs the Install Gate, and persists the Gate report into the lockfile only after success.

Commands cover `init`, `install`, `add`, `remove`, `update`, `audit`, `why`, and the existing `check`. Every command supports machine-readable output, reports data on standard output, logs diagnostics on standard error, and maps failures to the established exit codes. Mutating commands share the same orchestrator rather than growing their own pipelines.

## User Stories

1. As a Pyloros user, I want an `init` command that creates a minimal manifest with the Pyloros policy section, so that a new project starts correctly.
2. As a Pyloros user, I want `init` to refuse to overwrite an existing manifest, so that accidental data loss is impossible.
3. As a Pyloros user, I want `install` with no lockfile to resolve, write the lockfile, and install, so that the first run is one command.
4. As a Pyloros user, I want `install` with a lockfile to perform a Frozen Install by default, so that CI and teammates get exactly the Pinned tree.
5. As a Pyloros user, I want a Frozen Install to check Node version, ABI, and root specifications before touching disk, so that incompatible runtimes and manifest edits fail early.
6. As a Pyloros user, I want `install --re-resolve` to deliberately produce a new Clean Resolution Set, so that switching Node versions has an explicit path.
7. As a Pyloros user, I want `install --allow-advisories` to allow a verified Override Pin for an affected version, so that accepting a known risk is explicit.
8. As a Pyloros user, I want `install --select name@version` to resolve a fallback without a TTY, so that automation can make the same choice a human would.
9. As a Pyloros user, I want `add name` to resolve the package's latest dist-tag to an exact version, so that adding a dependency is simple.
10. As a Pyloros user, I want `add name@range` to respect a range and then save the exact chosen version, so that Pin is the default.
11. As a Pyloros user, I want `add --range` to save a caret range instead of an exact version, so that opt-out is available.
12. As a Pyloros user, I want `add` to update the manifest and lockfile atomically, so that a failure cannot leave them disagreeing.
13. As a Pyloros user, I want `add` to run the same Runtime Contract and advisory checks as resolution, so that one code path enforces policy.
14. As a Pyloros user, I want `remove` to delete the dependency from the manifest and re-resolve the remaining tree, so that the lockfile stays minimal.
15. As a Pyloros user, I want `remove` to refuse a package that is not declared, so that mistakes are visible.
16. As a Pyloros user, I want `update` with no argument to re-resolve the whole tree to the highest clean versions, so that routine maintenance is easy.
17. As a Pyloros user, I want `update name` to re-resolve that package and its dependents while keeping other Pins stable where possible, so that updates are scoped.
18. As a Pyloros user, I want every update to go through Fallback Selection when no clean version satisfies the constraints, so that conflicts are not silently resolved.
19. As a Pyloros user, I want `audit` to report open advisories for the locked tree, so that I can see risk without installing.
20. As a Pyloros user, I want `audit` to report provenance status for every package, so that unverified origins are visible.
21. As a Pyloros user, I want `audit` to report which lifecycle scripts are blocked, allowed, or skipped, so that Install Gate decisions are reviewable.
22. As a Pyloros user, I want `audit` to exit nonzero when advisories or Gate violations exist, so that CI can gate on it.
23. As a Pyloros user, I want `why name` to explain the selected version, every constraint that chose it, and any Override Pin, so that I can debug resolution.
24. As a Pyloros user, I want `why name` to show the package's advisories, provenance, and Gate status, so that the explanation includes security context.
25. As a Pyloros user, I want `why name` to fail clearly when the package is not in the tree, so that typos are distinguishable from missing Pins.
26. As a Pyloros user, I want `check` to keep verifying Frozen consistency without installing, so that CI has a cheap gate.
27. As a Pyloros user, I want every command to support a JSON mode, so that scripts do not parse human prose.
28. As a Pyloros user, I want JSON failures to include the exit code and message, so that automation has one parse path.
29. As a Pyloros user, I want human output on standard output and diagnostics on standard error, so that piping stays clean.
30. As a Pyloros user, I want a successful install to persist allowed scripts, reasons, and provenance digests into the lockfile, so that the decision is reproducible.
31. As a Pyloros user, I want a failed install to persist nothing, so that permissions are never recorded for an install that did not happen.
32. As a Pyloros user, I want a Frozen Install with allowlisted scripts to re-verify provenance against the recorded digest, so that a stale lockfile cannot bypass the Provenance Gate.
33. As a Pyloros user, I want a Frozen Install to fail closed when provenance re-verification is impossible, so that offline installs never weaken the Gate.
34. As a Pyloros user, I want a changed attestation digest to fail with the integrity/provenance exit code, so that tampering is specific.
35. As a Pyloros user, I want `install` to print which scripts were skipped, so that I know what may need an allowlist.
36. As a Pyloros user, I want `install` to fail when a package needs a source build but is not allowlisted, so that broken trees are not installed silently.
37. As a Pyloros user, I want commands to refuse to run outside a project with a manifest, so that mistakes do not write files in the wrong directory.
38. As a Pyloros user, I want manifest edits to preserve valid JSON and consistent formatting, so that diffs stay reviewable.
39. As a Pyloros user, I want the lockfile to remain byte-stable when a command makes no changes, so that no-op runs do not create noise.
40. As a Pyloros user, I want `--json` and human modes to report the same facts, so that behaviour is consistent across consumers.
41. As a maintainer, I want every command to share one orchestrator, so that policy enforcement cannot drift between commands.
42. As a maintainer, I want command tests to spawn the real entry point, so that exit codes and output contracts are verified from outside.

## Implementation Decisions

- A single `installProject` orchestrator is introduced and becomes the only behavioural seam for mutating commands. Commands parse arguments, call the orchestrator, and format the result. They do not compose resolution, lockfile, materialization, or Gate logic themselves.
- The orchestrator reads the manifest, loads the lockfile if present, and chooses one of three paths: Frozen Install when a lockfile exists and re-resolution is not requested, fresh resolution when no lockfile exists, or Re-resolution when explicitly requested.
- Frozen Install runs the existing drift checks before materialization. Node or ABI drift is a Runtime Contract failure. Root drift is a Frozen drift failure.
- A fresh resolution runs the resolver with the advisory provider, applies any selected Override Pins, creates the lockfile, materializes, and persists the Gate report.
- Re-resolution behaves like a fresh resolution but is only reachable through the explicit flag. It still requires the current Node version to satisfy the Runtime Contract.
- The orchestrator accepts the advisory provider, provenance verifier, sandbox runner, fallback selector, allow-advisories switch, non-interactive selection, clock, and output sink as options. The CLI wires the real implementations; tests inject fakes.
- The CLI wires the cosign-backed provenance verifier using the registry configuration and the cosign discovery path. It wires the bubblewrap sandbox. Missing cosign for allowlisted scripts remains an Install Gate refusal. Missing bubblewrap remains an Install Gate refusal.
- The orchestrator returns a result containing whether the lockfile was written, the resolution summary when one occurred, the materialization result, the Gate report, and the list of skipped scripts.
- Gate persistence happens only after a successful materialization and Gate run. For each package with an allowlist match, the orchestrator writes a Gate record containing the allowed script names and the reason. For each package, it writes the provenance status and, when verified, the attestation digest, subject integrity, and verification timestamp. The lockfile is then written atomically.
- A Frozen Install with allowed scripts passes the lockfile's expected provenance into the Gate so that the freshly verified attestation digest can be compared with the recorded one. A mismatch is an integrity/provenance failure. If no verifier is available, the install fails closed.
- Script bodies remain in the lockfile so a Frozen Install never re-fetches metadata to run an allowed script.
- `init` writes a minimal manifest with name, version, private, type, engines, and the Pyloros policy section, and refuses when a manifest already exists.
- `add` accepts an exact version, range, or dist-tag. Dist-tags are resolved through the packument and then saved as an exact version by default. The manifest and lockfile writes are staged and atomic. `--range` saves a caret range.
- `remove` requires the dependency to be declared, removes it from both dependency tables, and re-resolves.
- `update` without a name re-resolves the whole tree. `update name` constrains the named package to a fresh resolution while preserving other Pins where the solver can, and fails clearly when the requested scope cannot be honoured.
- All commands support JSON mode. JSON success output contains an ok flag plus command-specific data. JSON failure output contains an ok flag, exit code, and message. Human diagnostics go to standard error; data goes to standard output.
- `audit` operates on the lockfile and advisory snapshot. It exits nonzero when advisories are present or when the Gate report shows violations. `why` operates on the lockfile and resolution metadata and fails clearly when the identity is absent.
- Package manifest edits preserve JSON validity and use two-space formatting with a trailing newline.
- No-op commands do not rewrite the lockfile, keeping bytes stable.
- Commands resolve the project root from the current directory. A missing manifest is a usage error.
- Self-hosting the repository's own development dependencies is not part of this spec.

## Testing Decisions

- The single behavioural seam for mutating commands is `installProject`. Tests drive Frozen Installs, fresh resolutions, Re-resolution, Gate persistence, provenance re-verification, and failure rollback through it using fake registries, advisory providers, provenance verifiers, and sandbox runners in temporary projects.
- Command modules are thin and are tested by spawning the real CLI. Assertions cover exit codes, standard output, standard error, and JSON shapes for `init`, `install`, `add`, `remove`, `update`, `audit`, `why`, and `check`.
- Orchestrator tests assert lockfile byte stability for no-op runs, Gate records persisted only after success, no persistence after a script failure, frozen provenance mismatch failure with the integrity code, and missing verifier failure closed.
- A Linux-only integration test may exercise a real allowlisted script through the CLI once bubblewrap is confirmed available; otherwise the sandbox stays faked at the orchestrator seam.
- Prior art: spawned CLI tests for exit codes, temporary projects, fake provider seams, lockfile round-trip tests, and the existing Materialize tests.
- No new seam is introduced per command. The command layer remains a formatting and argument-parsing shell over the orchestrator.

## Out of Scope

- Self-hosting the repository's own development dependencies.
- Node 22 and 24 matrix automation and the full integration suite; those belong to the next milestone.
- Workspaces, publish, private registries, authentication, and mirrors.
- Bin linking and `node_modules/.bin` population.
- Post-selection conflict fallback, which remains a known limitation.
- macOS and Windows sandboxing.
- Lockfile schema migrations and cache eviction.
- Telemetry, progress spinners, and interactive prompts beyond Fallback Selection.

## Further Notes

- Frozen Installs are the default everywhere. Any command that would change versions must say so explicitly.
- Persisting Gate records only on success is deliberate: a failed script must not leave a permission that was never exercised.
- The orchestrator is the only place that decides between Frozen, fresh, and Re-resolution. Keeping that decision in one place is what prevents policy drift between `install`, `add`, `remove`, and `update`.
- Self-hosting is expected to be sensitive to the Runtime Contract, because some development-only packages may not declare `engines.node`. That risk is deferred to the self-hosting milestone rather than weakening the contract here.
