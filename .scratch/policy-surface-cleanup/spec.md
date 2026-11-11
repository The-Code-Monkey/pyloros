# Delete the unused policy surface and unify lifecycle policy

Status: ready-for-agent
Recorded: 2026-11-11

## Problem Statement

The manifest policy interface promises two capabilities that nothing consumes: `pins` and `allowAdvisories`. They are parsed, validated, written into new manifests and tested, but resolution, materialization and the Gate never read them. Separately, the set of lifecycle scripts is defined in Gate and again, with a different meaning, in audit and why. The policy interface is wider than the implementation behind it, and lifecycle policy leaks across command seams.

## Solution

Remove the unused policy fields and keep the policy interface to capabilities that are actually enforced. Move the canonical lifecycle-script definition into one module used by Gate, audit and why. If pins or manifest-level advisory exceptions are wanted later, they get their own spec and their own consuming implementation.

## User Stories

1. As a Pyloros user, I want the manifest policy section to list only options that change behaviour, so that I can trust what I write.
2. As a Pyloros user, I want `pins` removed while it is unenforced, so that it does not silently do nothing.
3. As a Pyloros user, I want `allowAdvisories` removed from the manifest while it is unenforced, so that the CLI switch remains the only advisory override.
4. As a Pyloros user, I want `init` to write only enforced policy fields, so that new projects start honest.
5. As a Pyloros user, I want existing manifests with removed fields to be rejected clearly, so that stale intent does not linger silently.
6. As a Pyloros user, I want `allowScripts` to stay exactly as it is, so that the Install Gate intent is unchanged.
7. As a Pyloros user, I want Gate, audit and why to agree on lifecycle scripts, so that the report matches execution.
8. As a Pyloros user, I want audit to report blocked lifecycle scripts only, so that build and test script names do not appear as Gate concerns.
9. As a Pyloros user, I want why to report blocked lifecycle scripts only, so that it matches audit.
10. As a Pyloros user, I want preinstall, install and postinstall to be the canonical lifecycle set, so that Gate behavior is explicit.
11. As a maintainer, I want one lifecycle-script module, so that the definition has locality.
12. As a maintainer, I want Gate to import that module, so that execution order and the reported set cannot drift.
13. As a maintainer, I want audit and why to import that module, so that command output cannot invent a second meaning.
14. As a maintainer, I want the policy parser to reject unknown policy fields, so that removed options fail loudly.
15. As a maintainer, I want the policy interface to shrink, so that future policy additions require a consuming implementation.
16. As a maintainer, I want tests for removed fields deleted, so that the suite stops encoding dead capability.
17. As a maintainer, I want lifecycle tests centralized, so that Gate, audit and why tests do not repeat the list.
18. As a maintainer, I want no ADR change, so that this cleanup does not re-litigate advisory or Gate decisions.

## Implementation Decisions

- `pins` and `allowAdvisories` are removed from the manifest policy model, parser, initial manifest template and fixtures.
- Unknown fields inside the policy section are rejected with a usage error, so a stale `pins` or `allowAdvisories` entry fails clearly rather than being ignored.
- `allowScripts` remains the only manifest policy field.
- The CLI advisory override remains the only advisory exception path. Fallback Selection and Override Pin behavior are unchanged.
- A Lifecycle Scripts module owns the ordered set: preinstall, install, postinstall. Gate uses it for execution ordering. Audit and why use it for blocked-script reporting.
- Audit and why stop classifying every script key as blocked; only lifecycle scripts are reported.
- No resolution, advisory, provenance or Gate execution behaviour changes.
- This is a deletion and unification, not a new feature.

## Testing Decisions

- A good test asserts the policy parser's accepted and rejected fields and the shared lifecycle output from Gate, audit and why.
- Tests cover `allowScripts` acceptance, removal of `pins` and `allowAdvisories`, rejection of stale policy fields, init output, and identical lifecycle classification across Gate, audit and why.
- Existing Gate tests remain; the lifecycle module is tested once and referenced by command tests.
- Prior art: manifest parsing tests, command JSON tests and Gate report tests.

## Out of Scope

- Implementing manifest-level pins or advisory exceptions.
- Changing the CLI `--allow-advisories` switch.
- Changing Gate sandbox execution or provenance policy.
- Changing Fallback Selection or Override Pin schema.
- Workspaces and dependency groups.

## Further Notes

- Removing fields is safe because no released consumer exists and the fields currently promise leverage they do not provide.
- If a future milestone wants manifest-level Pins, that spec must define where they participate in resolution and how they interact with preferred versions.
- This is a deletion-test win: the unused policy surface disappears, while the real lifecycle policy concentrates in one module.
