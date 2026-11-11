# Deepen the resolver with a Candidate Selection module

Status: implemented
Recorded: 2026-11-11

## Problem Statement

The resolver's candidate selection is a shallow interface with too many reasons to change. It filters ranges, applies the Runtime Contract, queries advisories, applies preferred versions, builds a Fallback Selection request, validates the fallback choice, and constructs an Override Pin. Failure kinds are produced there and later mapped to exit codes. Tests can only reach this behaviour by running a whole resolution, so failure precedence, preference ordering and the advisory query path are hard to isolate.

## Solution

Extract a Candidate Selection module inside the resolver. One small interface answers: for this Package Identity and these constraints, what clean versions can be chosen, what override was selected, or what typed failure applies. The existing solver keeps constraint propagation, backtracking and the selection budget. The public `resolve` interface and the Clean Resolution Set outcome stay unchanged.

## User Stories

1. As a maintainer, I want candidate selection behind one interface, so that range, contract, advisory, preference and fallback policy live in one module.
2. As a maintainer, I want the solver to stop knowing how a candidate is chosen, so that backtracking and candidate policy can change independently.
3. As a maintainer, I want a clean-candidate outcome, so that normal selection is one branch rather than a chain of filters.
4. As a maintainer, I want an override outcome, so that Fallback Selection returns a selected version plus its Override Pin.
5. As a maintainer, I want a typed failure outcome, so that contract, advisory and conflict failures are distinguishable without exit-code knowledge.
6. As a maintainer, I want exit-code mapping to stay in the resolver's outer layer, so that Candidate Selection never imports CLI policy.
7. As a Pyloros user, I want the highest clean version selected as before, so that resolution behaviour does not change.
8. As a Pyloros user, I want a preferred pinned version chosen first when it still satisfies all constraints, so that scoped updates stay stable.
9. As a Pyloros user, I want Runtime Contract violations skipped as before, so that declared incompatibility is still refused.
10. As a Pyloros user, I want packages without a usable engines range accepted, so that ADR 0004 is preserved.
11. As a Pyloros user, I want advisory-affected versions skipped before selection, so that the highest clean version wins.
12. As a Pyloros user, I want a Fallback Selection request only when every range-satisfying version is affected, so that the prompt is not noisy.
13. As a Pyloros user, I want conflict fallback when a conflict is known before selection, so that manual resolution remains available.
14. As a Pyloros user, I want choosing an affected version to require the advisory override switch, so that risk acceptance stays explicit.
15. As a Pyloros user, I want a clean out-of-range override allowed through Fallback Selection, so that conflicts can be resolved deliberately.
16. As a Pyloros user, I want every override recorded with a reason, timestamp, waived constraints and advisory identifiers, so that the decision is auditable.
17. As a Pyloros user, I want candidate ordering deterministic, so that repeated resolutions produce the same Pin.
18. As a maintainer, I want advisory data queried once per selection pass, so that the range-satisfying and fallback paths do not repeat work.
19. As a maintainer, I want advisory data for all contract-compatible versions fetched only when building a fallback request, so that normal resolution stays cheap.
20. As a maintainer, I want the selection budget tested, so that the max-selection guard is not an invisible promise.
21. As a maintainer, I want the Fallback Selector injected, so that tests can drive fallback decisions without a terminal.
22. As a maintainer, I want end-to-end resolver tests kept as integration checks, so that the public `resolve` interface remains proven.
23. As a maintainer, I want Candidate Selection tests that build no full graph, so that failure precedence is cheap to verify.
24. As a maintainer, I want ADR 0002's Fallback Selection rule preserved, so that the architecture change does not re-litigate advisory policy.

## Implementation Decisions

- A new Candidate Selection module is introduced inside the resolver. Its interface takes a Package Identity, its packument, the hard constraints, the running Node version, an advisory provider, an optional preferred version, the allow-advisories switch, an optional Fallback Selector, and a clock.
- The interface returns a discriminated outcome: a list of clean candidate versions, an override containing a chosen version and an Override Pin, or a typed failure whose kind is contract, advisory or resolution.
- Candidate Selection never knows about exit codes, CLI errors, `process` paths, or output formatting.
- Candidate Selection owns range filtering, Runtime Contract filtering, advisory lookup, candidate ordering, preferred-version promotion, Fallback Selection negotiation, override validation and Override Pin construction.
- Advisory lookup runs once for the range-satisfying contract-compatible versions. The full contract-compatible set is queried only when a Fallback Selection request is needed.
- Failure precedence is fixed: contract failure when no contract-compatible version exists and at least one version declares an incompatible range; advisory failure when range-satisfying versions exist but all are affected; resolution conflict otherwise.
- Fallback candidates remain limited to contract-compatible versions, because the Runtime Contract is never overridable.
- A preferred version is promoted to the front only when it already appears in the clean candidate list.
- The solver keeps state, constraint addition, edge application, backtracking, selection ordering, the selection budget and failure propagation.
- The outer resolver maps typed failures to the existing contract, advisory and resolution errors, preserving exit codes 4, 5 and 3.
- The public `resolve` interface, Clean Resolution Set shape, Advisory Snapshot and Override Pin records are unchanged.
- No behaviour change is intended. This is a deepening refactor.

## Testing Decisions

- A good test crosses the Candidate Selection interface and asserts the returned outcome, not internal helper calls.
- New tests cover clean selection, preferred promotion, contract filtering, advisory filtering, all-affected fallback, pre-selection conflict fallback, affected override refusal, affected override acceptance, out-of-range clean override, reason validation, deterministic ordering and failure precedence.
- The advisory query count is tested once per pass, and the full-version advisory query is tested only on the fallback path.
- The selection budget is tested through the public resolver because the budget remains solver state.
- Existing resolver and advisory-resolver tests remain as end-to-end checks of the public interface.
- Prior art: fake packument providers, fake advisory providers, exit-coded error assertions and deterministic comparisons in the existing resolver tests.

## Out of Scope

- Changing the resolution algorithm, backtracking strategy or clean-version preference rules.
- Changing advisory severity policy, Fallback Selection UX or Override Pin schema.
- Performance tuning beyond removing the duplicate advisory query.
- Reworking the solver's state representation.

## Further Notes

- ADR 0002 and ADR 0004 constrain this work. Fallback Selection and the treatment of undeclared engines must not change.
- The duplicate advisory query is a symptom of the shallow interface, not the reason for the refactor. Fixing it while extracting is acceptable because behaviour is unchanged.
- If Candidate Selection later needs a second adapter, that is the point at which a seam outside the resolver should be considered. Today it is one internal seam.
