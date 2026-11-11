# Pyloros

Pyloros is a security-first package manager for the npm ecosystem. It enforces one version per package and refuses packages that cannot run on the current Node.js version or that carry a known security advisory.

## Language

**Pyloros**:
The package manager that produces and installs a Clean Resolution Set.
_Avoid_: npm client, installer, tool

**Package Identity**:
The registry name that identifies a package. One identity has at most one version in a tree.
_Avoid_: module, dependency, library

**Runtime Contract**:
The requirement that a package declares a Node.js version range that includes the exact running version.
_Avoid_: engine check, compatibility check

**Clean Resolution Set**:
The single-version package tree in which every package satisfies all declared ranges and peer constraints and has no open security advisory.
_Avoid_: dependency tree, solution, graph

**Pin**:
The exact version recorded as authoritative for a Package Identity in an install.
_Avoid_: lock entry, resolution

**Frozen Install**:
An install that materializes the recorded tree without resolving new versions.
_Avoid_: deterministic install, replay

**Re-resolution**:
Producing a new Clean Resolution Set, permitted only for a different Node.js version or an explicit update.
_Avoid_: refresh, reinstall, sync

**Advisory Snapshot**:
The record of security advisories that were known when a resolution was produced.
_Avoid_: audit cache, vulnerability list

**Fallback Selection**:
The explicit choice of a package version when no clean version satisfies all constraints.
_Avoid_: override prompt, manual resolve

**Override Pin**:
A Fallback Selection recorded together with why it was necessary.
_Avoid_: force, exception, ignore

**Install Gate**:
The rule that package lifecycle scripts do not run unless explicitly allowed.
_Avoid_: postinstall policy, script sandbox

**Provenance Gate**:
The rule that a package's published origin attestation must verify before its code may run.
_Avoid_: signature check, attestation check

**Platform Variant**:
A build of a package selected by operating system, CPU architecture, and C library.
_Avoid_: binary, optional dependency

**Store**:
The shared cache of verified package contents that installs link into place.
_Avoid_: cache, warehouse
