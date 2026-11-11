# Manifest, Runtime Contract, and single-version resolution

Status: implemented
Recorded: 2026-11-11

## Problem Statement

npm-style resolution permits many versions of the same package in one tree, and it permits packages that were never meant to run on the current Node.js version. Both behaviours enlarge the attack surface and make an installed tree hard to review. A user needs Pyloros to read a normal package manifest, reject dependency sources outside the registry, refuse packages that do not declare compatibility with the exact running Node.js version, and produce one version per Package Identity.

## Solution

Pyloros reads `package.json`, validates dependency specifiers as registry semver ranges, and reads its own policy section. It enforces the Runtime Contract: every package must declare an `engines.node` range that includes the exact running Node.js version. It then produces a Clean Resolution Set: one version per Package Identity, chosen as the highest version that satisfies every declared range and every peer constraint and passes the Runtime Contract. Resolution is deterministic, cycle-safe, and backtracks when a higher choice makes a later constraint unsatisfiable.

## User Stories

1. As a Pyloros user, I want to keep using `package.json`, so that adopting Pyloros does not require a new manifest format.
2. As a Pyloros user, I want dependency ranges validated as registry semver ranges, so that typos fail before resolution.
3. As a Pyloros user, I want git, URL, file, workspace, and alias specifiers rejected, so that every package comes from the audited registry path.
4. As a Pyloros user, I want optional and peer dependency tables parsed, so that real manifests are understood.
5. As a Pyloros user, I want an `engines.node` range to be mandatory for every package, so that no package silently skips the Runtime Contract.
6. As a Pyloros user, I want the range checked against the exact running Node.js version, so that a package declaring only an older major line is refused.
7. As a Pyloros user, I want a missing, empty, or invalid engines range refused, so that malformed compatibility data is not ignored.
8. As a Pyloros user, I want versions that violate the Runtime Contract excluded from the candidate set, so that resolution can fall back to a compatible version.
9. As a Pyloros user, I want a distinct exit code when no version can satisfy the Runtime Contract, so that CI can tell it apart from a range conflict.
10. As a Pyloros user, I want one version per Package Identity, so that the installed tree is reviewable.
11. As a Pyloros user, I want the highest version satisfying every range, so that resolution prefers current code.
12. As a Pyloros user, I want transitive ranges to collapse onto the same version, so that shared dependencies are not duplicated.
13. As a Pyloros user, I want resolution to backtrack, so that a greedy highest choice does not cause a false conflict.
14. As a Pyloros user, I want deterministic selection order and tie-breaking, so that repeated resolutions produce the same tree.
15. As a Pyloros user, I want peer ranges treated as hard constraints, so that a plugin and its host cannot silently disagree.
16. As a Pyloros user, I want a required peer installed when nothing else provides it, so that plugins work out of the box.
17. As a Pyloros user, I want an absent optional peer to stay absent, so that optional integrations do not force extra packages.
18. As a Pyloros user, I want an optional peer range enforced once the peer is present, so that an existing peer cannot violate the plugin's contract.
19. As a Pyloros user, I want dependency cycles handled, so that mutually dependent packages resolve instead of looping.
20. As a Pyloros user, I want a selection budget, so that pathological graphs fail instead of running forever.
21. As a Pyloros user, I want a conflict error that lists the competing ranges and their sources, so that I can fix the manifest.
22. As a Pyloros user, I want a conflict exit code distinct from other errors, so that automation can branch correctly.
23. As a Pyloros user, I want the policy section to accept script allowlist entries with a reason, so that later Gate decisions have intent.
24. As a Pyloros user, I want policy pins to be exact versions, so that a pin means one thing.
25. As a Pyloros user, I want advisory overrides parsed now, so that later advisory handling has a stable manifest surface.
26. As a maintainer, I want correct semver range behaviour without a runtime dependency, so that the zero-dependency rule holds.
27. As a maintainer, I want a fake registry in tests, so that resolution scenarios are explicit and fast.

## Implementation Decisions

- The manifest parser reads dependencies, optional dependencies, peer dependencies, engines, and the Pyloros policy section from `package.json`. The project directory is retained with the parsed manifest.
- Dependency specifiers containing source prefixes or URL schemes are rejected with a usage error. Remaining specifiers must be valid semver ranges.
- Policy validation requires a non-empty reason for every script allowlist entry, exact versions for pins, and non-empty strings for advisory overrides.
- The Runtime Contract requires a non-empty `engines.node` string that parses as a range and includes the exact running version, with prereleases eligible. Missing, empty, and invalid ranges are violations.
- Range satisfaction for package versions uses normal semver semantics without prereleases. Runtime Contract checking includes prereleases.
- Resolution state tracks hard constraints, soft constraints, selected versions, and a selection budget. Soft constraints represent optional peers and are promoted when a Package Identity becomes required.
- Root and dependency edges add hard constraints. Peer edges add hard constraints and may auto-install a required peer. Optional peers stay soft until the peer is otherwise required or selected.
- Candidate versions are all valid semver versions of the packument that satisfy every hard constraint and pass the Runtime Contract. Candidates are ordered highest first.
- The solver picks the unresolved Package Identity with the alphabetically smallest name, tries candidates highest first, applies that candidate's edges, and backtracks when a later constraint invalidates an earlier choice.
- Adding a constraint to an already selected package revalidates that selection immediately.
- Optional dependencies are treated as required constraints in this stage. Platform-specific handling is deferred to materialization.
- Conflicts throw the resolution-conflict error with the competing ranges and sources, plus available versions.
- An exhausted Runtime Contract candidate set throws the Runtime Contract error with per-version reasons.
- The resolver depends only on a packument provider interface, not on the concrete registry client, so tests inject a fake registry.
- Semver is vendored from node-semver under its ISC license. The build copies the vendored files so source and compiled runs resolve the same module. Vendoring preserves zero runtime dependencies while avoiding a hand-rolled range parser.

## Testing Decisions

- The primary seam is the resolver's public entry point, driven by a fake packument provider. Tests assert the resulting Package Identity and version pairs, and the thrown exit-coded error.
- Resolver tests cover highest-satisfying selection, transitive range collapse, hard conflict, backtracking to a lower version, Runtime Contract exclusion, all-versions contract failure, required peer auto-install, peer conflict, absent optional peer, optional peer enforcement when present, cycles, and determinism.
- Manifest tests cover parsing the real fixture manifest, rejecting source specifiers and invalid ranges, requiring reasons, requiring exact pins, and parsing policy entries.
- Contract tests cover accepted ranges, missing engines, excluded versions, and invalid ranges.
- A network-guarded integration test resolves the real-world fixture against the public registry and asserts the pinned identities. It is skipped unless explicitly enabled.
- Prior art: fake providers, exit-coded error assertions, and deterministic deep comparisons.

## Out of Scope

- Advisories, Fallback Selection, and Override Pins.
- Lockfile writing, Frozen Installs, and drift checks.
- Script execution, provenance, and sandboxing.
- Platform filtering at resolution time.
- Aliases, forks, git sources, URL sources, and file sources.
- Workspaces, publish, and dependency updates.

## Further Notes

- The vendored semver license is ISC, not MIT as initially assumed. The vendoring note records the source version and the update procedure.
- Treating optional dependencies as required is a deliberate simplification until the lockfile can carry edge optionality. It does not affect correctness, because platform filtering at materialization removes variants that cannot run.
- The reference-counted soft-constraint mechanism is the part most likely to need revisiting if resolution performance becomes a concern.
