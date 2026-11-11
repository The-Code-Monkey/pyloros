# Install Gate, Provenance Gate, and sandboxed scripts

Status: implemented
Recorded: 2026-11-11

## Problem Statement

Pyloros currently materializes a Clean Resolution Set without ever executing package lifecycle scripts, which is safe but incomplete: packages that legitimately need a native build or an install step are silently unusable, and there is no mechanism for a user to accept that risk explicitly. At the same time, Pyloros has no way to verify that a package came from the source it claims, so a compromised publish would still be installed as long as its integrity hash and advisory status are clean.

A user needs a way to explicitly allow a specific pinned package to run a specific install script, with a recorded reason, inside an environment that cannot reach the network, cannot modify the Store, and cannot see the user's home directory. They also need assurance that the code they are allowing is the code that was published, verified against a signed origin attestation.

## Solution

Pyloros gains an Install Gate and a Provenance Gate that run as part of materialization, before the staged tree is swapped into place.

Every package is still denied script execution by default. A package may run lifecycle scripts only when the user has allowlisted that exact Package Identity and exact version in the manifest with a reason, and only when its published provenance attestation verifies against the tarball's integrity. Allowed scripts run sequentially after the staged tree is complete, inside a bubblewrap sandbox with no network, a read-only Store and system, a writable package directory, a temporary home, a wall-clock timeout, and process cleanup on exit.

Packages that ship a prebuilt Platform Variant are installed and used without running any script. Packages that require a source build, detected by build files or native build scripts, are refused unless explicitly allowlisted.

Gate and provenance decisions are returned as a report so the caller can pin them into the lockfile. On a Frozen Install, allowlisted scripts are re-verified against the recorded attestation digest; if that verification is unavailable, the install fails closed.

## User Stories

1. As a Pyloros user, I want lifecycle scripts to remain blocked by default, so that installing an untrusted package cannot execute arbitrary code on my machine.
2. As a Pyloros user, I want a package with scripts to install successfully when the scripts are blocked, so that I can still inspect and use the rest of the tree.
3. As a Pyloros user, I want to allowlist a specific package version in my manifest with a written reason, so that the exception is explicit and reviewable in code review.
4. As a Pyloros user, I want my allowlist entry to apply only to the exact version I named, so that an update cannot silently inherit script permission.
5. As a Pyloros user, I want an allowlist entry for a version that is not in the tree to have no effect, so that stale permissions cannot be assumed.
6. As a Pyloros user, I want an allowlist entry without a reason to be rejected while reading my manifest, so that every exception carries an explanation.
7. As a Pyloros user, I want an allowed script to run only inside a sandbox, so that a malicious script cannot reach the network or rewrite my files.
8. As a Pyloros user, I want the sandbox to have no network access, so that a script cannot phone home, exfiltrate data, or download a second stage.
9. As a Pyloros user, I want the sandbox to see the Store and system directories as read-only, so that a script cannot poison the shared cache for future installs.
10. As a Pyloros user, I want the sandbox to hide my home directory and environment secrets, so that anything the script reads cannot leak my tokens or SSH keys.
11. As a Pyloros user, I want the sandbox to have a writable temporary directory and a writable package directory, so that normal build tools can still do their job.
12. As a Pyloros user, I want allowed scripts to run with a timeout and to be killed with their children when they exceed it, so that a hung or looping script cannot block an install indefinitely.
13. As a Pyloros user, I want all scripts to run before the new tree replaces the old one, so that a failed script leaves my previous node_modules untouched.
14. As a Pyloros user, I want a non-zero script exit to fail the install with the Install Gate exit code, so that automation can distinguish it from a resolution or advisory failure.
15. As a Pyloros user on a machine without bubblewrap, I want the install to refuse allowlisted scripts rather than run them unsandboxed, so that the sandbox guarantee is never silently dropped.
16. As a Pyloros user on a non-Linux machine, I want the same refusal, so that v1 does not pretend to sandbox on unsupported platforms.
17. As a Pyloros user, I want Pyloros to fetch published provenance attestations for candidate packages, so that origin can be checked before any code runs.
18. As a Pyloros user, I want a valid attestation signature to be verified with the expected OIDC issuer, so that a self-signed or wrong-origin bundle is not accepted.
19. As a Pyloros user, I want the attestation subject digest to match the tarball integrity, so that a valid signature for a different artifact cannot be replayed.
20. As a Pyloros user, I want a bad or mismatched attestation to fail with the integrity/provenance exit code, so that tampering is clearly distinguished from policy denial.
21. As a Pyloros user, I want a package without provenance to still install when it has no allowed scripts, so that the long tail of older packages is not blocked.
22. As a Pyloros user, I want an allowlisted script to require verified provenance, so that executing code always implies a verified origin.
23. As a Pyloros user, I want a package with a prebuilt Platform Variant to install without any script execution, so that normal binary packages keep working.
24. As a Pyloros user, I want a package that requires a source build to be refused unless allowlisted, so that Pyloros does not install a package that cannot possibly work.
25. As a Pyloros user, I want the lockfile to record which scripts were allowed, for which version, and why, so that a Frozen Install reproduces the same Gate decision.
26. As a Pyloros user, I want the lockfile to record the verified provenance digest and subject, so that a later install can detect a changed attestation.
27. As a Pyloros user, I want a Frozen Install to re-verify provenance for allowlisted-script packages, so that a pre-existing lockfile cannot bypass origin checks.
28. As a Pyloros user, I want a Frozen Install to fail closed when re-verification is impossible, so that offline installs never weaken the Gate.
29. As a Pyloros user, I want the install report to list which scripts were skipped and why, so that I can decide whether to allowlist a package.
30. As a Pyloros user, I want a tampered lockfile with an invalid Gate record to be rejected, so that a hand-edited lockfile cannot widen script permissions.
31. As a Pyloros user, I want Gate and provenance failures to use distinct exit codes, so that CI can react differently to policy denial and to a failed signature.
32. As a Pyloros user, I want script order to be deterministic across installs, so that repeated installs behave the same way.
33. As a Pyloros user, I want a failed script to clean up the staging tree and preserve the previous node_modules, so that a broken build cannot leave a half-written tree.
34. As a Pyloros user, I want an interrupted install to recover the previous tree on the next run, so that a crash during a script cannot destroy my working setup.

## Implementation Decisions

- The single behavioural seam is `materialize`. It gains the manifest policy, a provenance verifier, a sandbox runner, a cosign discovery path, and a script timeout. It computes the Gate plan, verifies provenance, executes allowed scripts against the staged tree, and returns a Gate report. Existing options and behaviour remain unchanged when no scripts are involved.
- The Gate plan is computed after extraction, because build files such as `binding.gyp` must be inspected on disk, and before the atomic swap, so that script failure aborts the swap.
- Lifecycle scripts considered by the Gate are the package's declared `preinstall`, `install`, and `postinstall` entries. Only script names present in both the package and the allowlist entry may run. Other script names remain blocked.
- The manifest remains the source of intent: `allowScripts` maps a Package Identity at an exact version to a non-empty reason. The lockfile remains the source of Pin. An allowlist entry whose identity or version does not match the pinned package is ignored, not an error.
- The lockfile package record gains an optional `gate` object recording the allowed script names and the reason, an optional `provenance` object recording status (`verified` or `absent`), the attestation digest, the subject integrity, and when it was verified, and an optional `scriptCommands` map recording the exact script bodies needed to execute an allowlisted script. Both Gate-related objects are optional for backward compatibility; when present they are validated strictly. Script bodies were added to the lockfile because a Frozen Install must be able to run the recorded script without re-fetching metadata.
- A lockfile Gate record is valid only if every allowed script name also appears in that package's recorded script list, the reason is non-empty, and the record belongs to the pinned version. Violations are lockfile integrity errors.
- Provenance is fetched from the configured registry's attestations endpoint for the exact Package Identity and version. The provenance predicate is selected from the returned bundles, and the statement's subject digest must equal the package tarball's recorded integrity.
- Verification shells out to the `cosign` binary, which is resolved from `PYLOROS_COSIGN` or `PATH`. The invocation uses `cosign verify-blob` with the Sigstore bundle, expects the npm public-good OIDC issuer for GitHub Actions, verifies the transparency log, and binds the artifact digest to the subject. Failure to find cosign is an Install Gate refusal, not a provenance verification failure.
- A bad signature, wrong issuer, wrong subject digest, or missing transparency log entry is a provenance failure with the integrity/provenance exit code. A missing attestation is recorded as `absent`, not a failure, except where scripts are allowed.
- An allowlisted script requires a verified attestation before it runs. If attestation is absent, invalid, or cannot be fetched, the install fails with the Install Gate exit code for absent provenance and the integrity/provenance exit code for an invalid one.
- The sandbox is bubblewrap on Linux. Its arguments unshare the network and user namespaces, bind system directories read-only, bind the Store read-only, bind the staged package directory writable, mount a fresh temporary directory and home, mount `/proc` and `/dev`, enable process death with the parent, start a new session, and pass a minimal environment. The host home directory and ambient secrets are never mounted or forwarded.
- Because bubblewrap requires mount targets to exist inside the sandbox, the staged package directory is mounted at `/package` and the Store at `/store`. The script working directory is `/package`. This also keeps host paths out of the script's view.
- Scripts run with the current Node.js version, a working directory at the staged package directory, and an environment limited to a sandbox home, temporary directory, PATH, and non-secret locale settings.
- Scripts run sequentially after the whole staged tree exists, ordered deterministically by Package Identity. This keeps installs reproducible and lets later scripts see earlier package output.
- Each script has a wall-clock timeout, defaulting to five minutes and configurable through the materialize options. On timeout the sandbox is killed with its process group and the install fails with the Install Gate exit code.
- Any non-zero script exit fails the install with the Install Gate exit code. The staging tree is removed and the previous `node_modules` stays in place.
- Packages that contain build-requiring native sources and have no allowlist entry are refused with the Install Gate exit code, because they cannot function without a build and Pyloros will not silently install a broken package. Packages with prebuilt Platform Variants are materialized normally and never execute scripts.
- The Gate report lists, per package, which declared scripts were executed or skipped, the allowlist reason, whether the package looks like a source build, and the provenance status. The M6 deliverable returns this report; persisting it into the lockfile is the caller's responsibility and is wired in M7.
- Materialization accepts a provenance verifier. When none is supplied, an absent verifier is used: non-script packages are treated as having no attestation, and allowlisted scripts are refused. This keeps the library safe by default while letting M7 wire the cosign-backed verifier.
- Exit codes follow the established contract: integrity or provenance failure is `6`, Install Gate or sandbox refusal is `8`, Runtime Contract remains `4`, Frozen drift remains `7`.
- No new top-level `installProject` orchestrator is introduced in this spec. The CLI persistence step belongs to M7.

## Testing Decisions

- A good test asserts externally observable behaviour through the highest available seam and does not reach into module internals. For this feature, that means driving `materialize` with fixture tarballs, fake registries, a fake provenance verifier, and a fake sandbox runner, then asserting the resulting tree, report, thrown exit code, and preserved previous tree.
- The single behavioural seam is `materialize`. Tests cover: blocked scripts still install; allowlisted scripts execute; allowlist version mismatch does nothing; missing provenance blocks allowed scripts; invalid provenance fails with `6`; missing cosign fails with `8`; script non-zero exit and timeout fail with `8`; script failure preserves the previous tree and removes staging; deterministic script order; native source without allowlist fails with `8`; prebuilt Platform Variant installs without scripts.
- Adapter boundaries are faked, not executed, in behavioural tests. The provenance verifier fake returns valid, invalid, absent, and unavailable outcomes. The sandbox runner fake records the command and environment, and returns exit codes, signals, and timeouts on demand.
- Focused unit tests cover pure adapter logic: cosign argument construction, expected issuer and subject binding, sandbox argument construction, environment allowlisting, and timeout handling. These tests do not invoke the real cosign binary or bubblewrap.
- Lockfile schema tests extend the existing lockfile round-trip suite: Gate and provenance records survive canonical serialization, are stable across writes, and are rejected when the script name is not declared, the reason is empty, the version does not match, or the field types are wrong.
- A Linux-only integration test runs one allowlisted script under real bubblewrap, guarded by a bubblewrap availability check. It asserts that an attempted network request fails, that writing to the Store fails, and that writing inside the package directory succeeds. This test is skipped where bubblewrap is absent.
- Prior art: materialization tests already fake tarball sources and assert the resulting tree and atomic rollback; advisory tests already fake network providers; lockfile tests already cover round-trip and tamper rejection; CLI tests already assert distinct exit codes.
- A Linux-only integration test runs an allowlisted script under real bubblewrap, confirms the script writes inside the package directory, and confirms a write to the Store is refused. It skips when bubblewrap is unavailable.

## Out of Scope

- macOS and Windows sandboxing.
- Running scripts for packages that are not allowlisted, including a prompt-based flow.
- Reimplementing Sigstore, Fulcio, or Rekor in-process; v1 shells out to cosign.
- Private registries, authentication, and non-public attestation issuers.
- Bin linking and `node_modules/.bin` population.
- Publish, workspaces, and audit command output.
- Persisting the Gate report into the lockfile and wiring the install command; that is M7.
- Performance tuning of parallel attestation fetches.

## Further Notes

- This work implements ADR 0003, "Deny package code execution by default".
- The Gate report is intentionally returned rather than written so that M7 can decide when a lockfile is authoritative: a failed install must not persist permissions that were never exercised.
- Adding optional Gate and provenance fields keeps lockfile version 1 readable by existing parsers while new parsers validate the fields strictly when present.
- The bubblewrap absence refusal is deliberate. Falling back to unsandboxed execution would silently void the security guarantee the user opted into.
- The known M3 limitation around conflicts discovered after selection is unrelated to this spec and remains tracked separately.
