# Integration suite, Node matrix, and self-hosting

Status: implemented
Recorded: 2026-11-11

## Problem Statement

Pyloros passes its unit and fixture tests on one machine and one Node version. That is not enough to trust it. The resolver must work against the real registry, the CLI must work end to end on a real project, the test suite must run on every supported Node line, and the project should be able to manage its own development toolchain instead of depending on npm forever.

Self-hosting exposes a hard constraint: Pyloros requires every package to declare an `engines.node` range. The existing development dependencies did not all satisfy that, and TypeScript 7's native platform packages added another set of undeclared engines. A single committed lockfile also cannot serve two Node versions when the Runtime Contract pins the exact version.

## Solution

Pyloros gains a network-guarded integration suite, a two-version CI matrix, development-dependency support, a contract-compliant development toolchain, and a reproducible self-host check.

The integration suite installs the real-world fixture from the public npm registry, runs the installed application, performs a Frozen Install, and checks consistency. CI runs type checking, tests, and the build on Node 22 and 24, plus a separate network job. `devDependencies` become root edges for resolution, lockfile, and drift checks. The development toolchain is pinned to a TypeScript release with a declared engine, Node type declarations are vendored so they are not resolved as packages, and scripts invoke the compiler directly because bin linking is still deferred. A self-host check copies the project into a temporary directory, installs it with Pyloros, and type-checks it with the Pyloros-installed compiler.

## User Stories

1. As a maintainer, I want an integration test that installs a real project from the public registry, so that the whole pipeline is proven outside fixtures.
2. As a maintainer, I want that test to run the installed application, so that materialization is proven to produce a working tree.
3. As a maintainer, I want that test to perform a second Frozen Install, so that lockfile reproducibility is proven against the real registry.
4. As a maintainer, I want network tests skipped by default, so that the normal suite stays fast and offline-safe.
5. As a maintainer, I want network tests enabled by an explicit environment switch, so that CI can run them deliberately.
6. As a maintainer, I want type checking, tests, and the build to run on Node 22, so that the supported floor is real.
7. As a maintainer, I want the same checks on Node 24, so that the current line is real.
8. As a maintainer, I want a separate CI job for network integration tests, so that flaky external dependencies do not hide unit failures.
9. As a user, I want `devDependencies` resolved and installed, so that a normal project layout works.
10. As a user, I want development dependencies included in the lockfile root record, so that Frozen drift detects edits to them.
11. As a user, I want development dependency ranges validated like runtime ranges, so that source specifiers stay rejected.
12. As a user, I want development dependencies to follow the same Runtime Contract, so that the toolchain cannot bypass the rule it enforces.
13. As a maintainer, I want TypeScript pinned to a release that declares `engines.node`, so that the compiler itself satisfies the Runtime Contract.
14. As a maintainer, I want Node type declarations vendored, so that a package without engines is not part of the resolved tree.
15. As a maintainer, I want vendored declaration provenance and licenses recorded, so that the vendor directory is reviewable.
16. As a maintainer, I want the compiler invoked through its installed file path, so that self-hosting does not depend on unimplemented bin linking.
17. As a maintainer, I want a self-host check that installs the project with Pyloros in a temporary copy, so that the claim is demonstrated without corrupting the working repository.
18. As a maintainer, I want the self-host check to type-check with the Pyloros-installed compiler, so that the installed toolchain is proven usable.
19. As a maintainer, I want the repository to stay bootstrapped with npm, so that a Node-specific lockfile does not break the two-version matrix.
20. As a maintainer, I want the exact-Node lockfile tension documented, so that a future milestone can decide between per-Node lockfiles and a looser runtime contract.
21. As a maintainer, I want the existing fixture integration tests to keep working, so that resolver and sandbox coverage is preserved.
22. As a maintainer, I want local verification on both Node lines, so that the matrix is not trusted blindly.

## Implementation Decisions

- `package.json` now supports `devDependencies` in the manifest model. Ranges are validated with the same registry-only rule as runtime dependencies.
- The resolver treats development dependencies as root edges. They participate in the single-version Clean Resolution Set exactly like runtime dependencies.
- The lockfile root record gains a development dependency table. Frozen drift compares it alongside runtime and optional specifications, and root satisfaction checks include it.
- Removal and manifest editing operate across runtime, optional, and development tables.
- There is no production-only install mode in this stage. Installing a project includes development dependencies.
- The network integration suite lives with the tests and is skipped unless `PYLOROS_NETWORK=1`.
- The integration test copies the real-world fixture, runs the CLI install, asserts the resolved identities, runs the application, performs a Frozen Install, and runs `check`.
- The test script runs both the top-level test files and the integration directory.
- CI runs a matrix of Node 22 and 24 with `npm ci`, type check, tests, and build. A separate Node 24 job enables network tests.
- TypeScript is pinned to 5.9.3, which declares `engines.node >=14.17` and has no dependencies. TypeScript 7 was rejected for self-hosting because its platform packages do not declare engines and would be refused by the Runtime Contract.
- Node type declarations from `@types/node` and `undici-types` are vendored under a local types directory. `@types/node` is no longer a development dependency. Type roots and a path mapping point the compiler at the vendored declarations. Licenses and provenance are recorded.
- Build and type-check scripts invoke the compiler through the installed TypeScript file path, not through a bin link, because bin linking is not implemented.
- The self-host check copies the manifest, compiler configuration, source, and vendored types into a temporary directory, runs the built CLI install there, and runs the Pyloros-installed compiler. It does not write a lockfile into the repository.
- The repository remains npm-bootstrapped. Committing a self-host lockfile would pin Node 24 and fail the Node 22 matrix by design, because the Runtime Contract records the exact Node version.
- Local verification ran type check, tests, and build on Node 22.23.5 and Node 24.14.1.
- The self-host check passed against the public registry on Node 24.

## Testing Decisions

- The highest existing seams are reused: the spawned CLI, the resolver and Materialize seams, and temporary project directories.
- The network integration suite asserts only external behaviour: exit status, JSON output, resolved identities, lockfile presence, application output, and `check` success.
- Network tests are skipped unless explicitly enabled, so the default suite remains deterministic.
- CI is the matrix proof: both Node lines run the same commands. Local Node 22 and Node 24 runs are recorded as verification.
- The self-host check is a scripted end-to-end probe rather than a unit test, because it depends on the public registry and a complete project copy.
- Prior art: the existing real-world fixture test, the resolver network test, spawned CLI tests, and temporary-directory filesystem assertions.

## Out of Scope

- Bin linking and `node_modules/.bin` population.
- Production-only installs that exclude development dependencies.
- Per-Node lockfiles or a lockfile that can serve multiple Node versions.
- Committing a self-host lockfile to the repository.
- Workspaces, publish, private registries, and authentication.
- macOS and Windows support.
- Cache eviction and Store garbage collection.

## Further Notes

- The exact-Node Runtime Contract and a single committed lockfile are in direct tension for a project that must test on multiple Node lines. The matrix therefore uses npm bootstrap, while self-hosting is demonstrated in a temporary copy. Resolving this properly needs a deliberate decision, not a silent loosening.
- Vendoring Node type declarations is a self-hosting measure, not a runtime dependency. It keeps the resolved tree contract-compliant while preserving strict type checking.
- TypeScript 5.9 supports the import-extension rewriting already used by the project, so the downgrade did not change the source contract.
- The self-host check is a statement about the tool, not about day-to-day repository setup. The repository still uses npm for its own bootstrap.

## Superseded

The vendored Node type declarations and the TypeScript 5.9.3 pin were reversed after ADR 0004. The `types/` directory is removed, `@types/node` is a development dependency again, TypeScript is 7.0.2, and the self-host check copies no vendored declarations. The integration suite, CI matrix, development-dependency support, and self-host check remain.

## Follow-up

Self-hosting TypeScript 7 needs executable native artifacts. Tar extraction now reads the archive mode, preserves only the executable bit by normalizing files to `0755` or `0644`, and strips setuid, setgid, and sticky bits. Materialization preserves that mode on the copy fallback. This keeps prebuilt Platform Variants usable without trusting arbitrary archive permission bits.
