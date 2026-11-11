# Foundation: name, scaffold, toolchain, docs

Status: implemented
Recorded: 2026-11-11

## Problem Statement

The user wants a package manager in the style of npm, pnpm, and yarn, but built around a security-first model and given a Greek-god-themed identity. Before any registry, resolver, or installer code exists, the project needs a name that can be used consistently, a repository scaffold, a toolchain that keeps the security story credible, and documentation that records the decisions the rest of the project depends on.

## Solution

The project is named Pyloros, after the Greek gatekeeper. The name is used unscoped on npm and is carried through the CLI, configuration section, lockfile name, Store path, and environment prefix.

The repository is a TypeScript project with zero runtime dependencies. It runs on Node.js 22 or newer, compiles with `tsc` only, tests with `node:test`, and is bootstrapped with npm until it can manage its own development dependencies. The domain glossary and three foundational ADRs are written before feature code.

## User Stories

1. As a maintainer, I want a Greek-themed name that fits a security-first gatekeeper, so that the project has an identity rather than a generic "pm" placeholder.
2. As a maintainer, I want the npm package name to be free unscoped, so that publishing does not require a permanent scope decision.
3. As a maintainer, I want to avoid names already used by malware or unrelated tools, so that the project is not confused with something dangerous.
4. As a user, I want the CLI binary to share the project name, so that there is one word to remember.
5. As a user, I want the manifest policy section to share the project name, so that configuration is discoverable.
6. As a user, I want the lockfile to be named after the project, so that it is obviously Pyloros-owned.
7. As a user, I want the shared Store under a project-specific cache directory, so that it does not collide with npm or pnpm caches.
8. As a user, I want environment variables to use a project-specific prefix, so that configuration is unambiguous.
9. As a user, I want `--help` to list the intended commands, so that the tool explains itself.
10. As a user, I want `--version` to print the tool name and version, so that I can identify the installed build.
11. As a user, I want an unknown command to exit with the usage code, so that scripts can detect misuse.
12. As a user, I want distinct exit codes for usage, resolution conflict, Runtime Contract, advisories, integrity, Frozen drift, and Install Gate, so that automation can react precisely.
13. As a maintainer, I want zero runtime dependencies, so that the tool does not inherit a supply chain of its own.
14. As a maintainer, I want a strict TypeScript configuration, so that unsafe indexing and implicit any are caught early.
15. As a maintainer, I want `tsc` to be the only build step, so that no bundler or native build tool enters the toolchain.
16. As a maintainer, I want tests on `node:test`, so that the test runner adds no dependency.
17. As a maintainer, I want Node.js 22 or newer as the floor, so that modern APIs are available without polyfills.
18. As a maintainer, I want to bootstrap with npm and later self-host, so that the chicken-and-egg problem is explicit rather than hidden.
19. As a maintainer, I want a glossary that defines the domain language, so that later specs and code use one vocabulary.
20. As a maintainer, I want an ADR for using only the public npm registry, so that the rejection of mirrors, git, URL, and file sources is recorded.
21. As a maintainer, I want an ADR for advisory-aware single-version resolution, so that the rejection of nested trees and warn-and-continue is recorded.
22. As a maintainer, I want an ADR for denying package code execution by default, so that the sandbox and provenance posture is recorded.
23. As a maintainer, I want a minimal scaffold with source, tests, build output, and ignore rules, so that later milestones start from a clean base.
24. As a maintainer, I want the first CLI tests to spawn the real entry point, so that exit behaviour is tested from the outside.

## Implementation Decisions

- The name is Pyloros, chosen because it means gatekeeper and is free as an unscoped npm package. The runner-up was Adrasteia, and other Greek names were rejected because they were already taken or, in one case, shared with a malware family.
- The binary, npm package, manifest policy key, lockfile name, cache directory, state marker, and environment prefix all use the Pyloros name.
- The project is ESM with Node.js 22 or newer as the engine floor.
- Runtime dependencies are forbidden. Development dependencies are pinned exactly and currently limited to TypeScript and Node type definitions.
- The build is `tsc` only. Source imports use TypeScript file extensions and are rewritten to JavaScript on emit, so the same source runs directly under Node's type stripping during tests and compiles cleanly for distribution.
- Type checking is strict, including unchecked indexed access, override checks, and verbatim module syntax.
- Tests use the built-in Node test runner and are invoked through an explicit glob so fixture projects are never collected as tests.
- The CLI establishes the exit-code contract before commands exist: success, generic, usage, resolution conflict, Runtime Contract, advisory block, integrity, Frozen drift, and Install Gate.
- The CLI prints help, prints the version, and rejects unknown commands. All later commands hang off the same entry point.
- The glossary records Pyloros, Package Identity, Runtime Contract, Clean Resolution Set, Pin, Frozen Install, Re-resolution, Advisory Snapshot, Fallback Selection, Override Pin, Install Gate, Provenance Gate, Platform Variant, and Store.
- The three foundational ADRs record the public-registry-only decision, the advisory-aware single-version decision, and the deny-by-default execution decision.
- Linux is the only supported platform for the install-time security features; other platforms are deferred.
- npm is used only to bootstrap the development dependencies. Self-hosting is a later milestone, not part of this one.

## Testing Decisions

- Tests assert external behaviour: process exit status, standard output, and standard error. They spawn the real CLI entry point rather than importing internal functions.
- The CLI test suite covers help, version, and unknown-command behaviour.
- The build and type check are treated as verification steps: type check, run tests, compile, then run the compiled entry point.
- Prior art for later stages is established here: spawn the real process, assert exit codes and output, and avoid mocking the module under test.

## Out of Scope

- Registry access, resolution, lockfiles, installation, advisories, script execution, and provenance.
- Publishing the package to npm.
- Self-hosting the development dependency tree.
- macOS and Windows support.

## Further Notes

- The Greek naming exercise checked npm availability. Nearly every obvious Olympian and Titan name was already taken. Pyloros was selected for meaning, availability, and pronunciation.
- The CLI version is a source constant in this stage. Reading it from package metadata is a later concern.
- The ADRs written here constrain every later spec, so they are treated as authoritative context rather than background reading.
