# Canonical lockfile, Frozen Installs, and drift detection

Status: implemented
Recorded: 2026-11-11

## Problem Statement

A resolved tree is only useful if it can be reproduced. Without a committed record, two installs can produce different versions, a CI run can silently resolve something new, and switching Node.js versions can change which packages are compatible. A user needs a single authoritative lockfile that is stable in review, fails closed when the project drifts, and reports the difference between Node version drift and dependency drift.

## Solution

Pyloros writes `pyloros-lock.json` as canonical JSON with sorted keys and stable formatting. The lockfile records the tool version, the exact Node.js version and ABI used for resolution, the root dependency specifications, the Advisory Snapshot, every Pinned package with its integrity and resolved URL, platform fields, peer constraints, declared scripts, and every Override Pin.

A Frozen Install compares the lockfile with the manifest and the current runtime. Node version or ABI drift is a Runtime Contract failure. Changed root specifications, missing root packages, or locked versions outside the root ranges are Frozen drift failures. A `check` command exposes this comparison with distinct exit codes.

## User Stories

1. As a Pyloros user, I want a committed lockfile, so that a resolved tree can be reproduced.
2. As a Pyloros user, I want canonical JSON with sorted keys, so that diffs are minimal and reviewable.
3. As a Pyloros user, I want a stable trailing newline and formatting, so that repeated writes are byte-identical.
4. As a Pyloros user, I want the lockfile to record its schema version, so that future changes can be detected.
5. As a Pyloros user, I want the lockfile to record the tool that wrote it, so that provenance of the file is clear.
6. As a Pyloros user, I want the exact Node.js version recorded, so that a different runtime is detected.
7. As a Pyloros user, I want the Node.js ABI recorded, so that native compatibility is checked separately from the version string.
8. As a Pyloros user, I want the root dependency specifications recorded, so that a manifest edit is detected.
9. As a Pyloros user, I want the Advisory Snapshot recorded inline, so that one file reproduces one decision set.
10. As a Pyloros user, I want every package recorded under its Package Identity, so that one identity maps to one Pin.
11. As a Pyloros user, I want each package's exact version, integrity value, and resolved URL recorded, so that materialization does not need to re-resolve.
12. As a Pyloros user, I want engines, platform fields, peer constraints, deprecation, and declared scripts recorded, so that downstream stages have the metadata they need without another registry call.
13. As a Pyloros user, I want a shasum-only package converted to a sha1 integrity value, so that the lockfile always carries an integrity value.
14. As a Pyloros user, I want a package with no hash refused at lockfile creation, so that unverifiable content cannot be pinned.
15. As a Pyloros user, I want malformed or unsupported lockfiles rejected, so that a hand-edited file cannot smuggle unsafe data.
16. As a Pyloros user, I want a package record whose name does not match its key rejected, so that identity cannot be confused.
17. As a Pyloros user, I want an invalid exact version or resolved URL rejected, so that materialization cannot follow garbage.
18. As a Pyloros user, I want Override Pins preserved, so that advisory exceptions survive reproduction.
19. As a Pyloros user, I want a matching lockfile to pass silently, so that normal installs are uneventful.
20. As a Pyloros user, I want a Node version mismatch to fail with the Runtime Contract code, so that the cause is clear.
21. As a Pyloros user, I want an ABI mismatch to fail with the Runtime Contract code, so that native incompatibility is not mistaken for dependency drift.
22. As a Pyloros user, I want changed root specifications to fail with the Frozen drift code, so that I know to re-resolve.
23. As a Pyloros user, I want a root dependency missing from the lockfile to fail with the Frozen drift code, so that incomplete lockfiles are caught.
24. As a Pyloros user, I want a locked version outside the root range to fail with the Frozen drift code, so that a stale Pin is caught.
25. As a Pyloros user, I want Node drift to take precedence over root drift, so that an incompatible runtime is reported first.
26. As a Pyloros user, I want a `check` command that performs the comparison, so that CI can enforce a Frozen Install without installing.
27. As a Pyloros user, I want `check` to exit zero and print a confirmation when consistent, so that success is explicit.
28. As a Pyloros user, I want `check` to exit nonzero with a readable message otherwise, so that failures are actionable.
29. As a Pyloros user, I want every CLI error to map to its declared exit code, so that automation can distinguish causes.
30. As a Pyloros user, I want lockfile writes to be atomic, so that a crash cannot leave a truncated lockfile.
31. As a Pyloros user, I want a missing lockfile to read as absent rather than as an error, so that install can decide how to bootstrap.
32. As a maintainer, I want lockfile round-trip tests, so that canonicalization and parsing cannot drift apart.

## Implementation Decisions

- Canonical JSON recursively sorts object keys, preserves array order, drops undefined object members, converts undefined array members to null, rejects non-finite numbers, and ends with a newline.
- The lockfile is named after the tool and lives at the project root. Writes use a temporary file in the same directory followed by an atomic rename.
- The lockfile schema version is 1. Parsing rejects any other version.
- The schema records the tool identity, Node version, Node ABI, root dependency and optional-dependency specifications, Advisory Snapshot, package records, and Override Pins.
- The root specification block was added beyond the original schema sketch because Frozen drift detection needs the original ranges, not just the resolved versions.
- Each package record is keyed by Package Identity and repeats the name. It records exact version, integrity, resolved URL, engines, operating system, CPU, libc, peer dependencies, deprecation, and declared script names.
- Integrity prefers the registry's SRI value. A 40-character shasum is converted into a sha1 SRI value. Having neither is an integrity error.
- Parsing validates field types, the exact version, the URL protocol, the package name matching its key, advisory severity and source values, and Override Pin fields.
- Optional Gate and provenance fields are not part of this stage but the schema is designed so they can be added compatibly later.
- Frozen comparison uses canonical JSON for the root specification block, so key order cannot cause false drift.
- Node version and ABI mismatches are reported as Runtime Contract failures. All other drift is reported as Frozen drift. Node drift takes precedence.
- The drift report distinguishes changed root specs, missing root packages, and root ranges not satisfied by the locked version.
- The CLI wraps command execution in one error boundary that maps a Pyloros error to its exit code and prints a single readable line. Unknown errors become the generic exit code.
- The `check` command reads the manifest and lockfile, requires a lockfile, runs the Frozen comparison, and prints a confirmation on success.
- Reading a missing lockfile returns an absent result rather than throwing. A malformed lockfile is an integrity error.

## Testing Decisions

- Canonical JSON tests assert recursive key sorting, stability, newline termination, undefined handling, and array behaviour.
- Lockfile tests build a resolution and manifest, create a lockfile, and assert every recorded field, shasum conversion, refusal of missing integrity, canonical round-trip, atomic write and read, missing-file behaviour, unsupported version rejection, and name/key mismatch rejection.
- Frozen tests cover matching input, Node drift with exit code 4, ABI drift, changed root specs with exit code 7, missing root package, unsatisfied root range, and Node-drift precedence.
- CLI tests spawn the real entry point in temporary projects and assert exit codes 0, 4, 6, and 7 plus standard output and error.
- Prior art: temporary project directories, spawned CLI assertions, and canonical round-trip comparisons.

## Out of Scope

- Materializing `node_modules`, downloading tarballs, executing scripts, provenance, and install orchestration.
- Persisting a new lockfile after an install or re-resolution; that belongs to a later stage.
- Lockfile migration between schema versions.
- Workspace-level lockfiles and publishing.

## Further Notes

- The root specification block is the one schema addition beyond the initial design sketch. It is required for meaningful Frozen drift detection.
- The lockfile is deliberately human-readable JSON rather than a binary or compressed format, because reviewability is part of the security story.
- Exit code 6 covers both missing integrity at creation and malformed lockfile content, keeping integrity failures in one bucket.
