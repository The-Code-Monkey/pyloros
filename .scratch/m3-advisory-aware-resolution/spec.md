# Advisory-aware resolution and Fallback Selection

Status: implemented
Recorded: 2026-11-11

## Problem Statement

Choosing the highest version that satisfies the constraints is not enough when that version has a known security advisory. A user needs Pyloros to prefer the highest version that is both range-compatible and free of open advisories, and to make any decision that accepts a known vulnerability explicit, reasoned, and recorded.

## Solution

Pyloros queries OSV and the npm advisory endpoint for every candidate, unions the results, and treats any advisory at any severity as blocking. The highest clean version wins. When no clean version satisfies the constraints, Pyloros opens a Fallback Selection: it lists the contract-compatible candidate versions with their advisories and links, requires the user to type an exact `name@version`, and requires a reason. The choice becomes an Override Pin recording the version, timestamp, original constraints, and advisory identifiers. Accepting an affected version additionally requires the explicit advisory override switch.

Advisory lookups are cached per Package Identity with a time-to-live, fail closed when stale or unreachable, and produce an Advisory Snapshot pruned to the versions actually selected.

## User Stories

1. As a Pyloros user, I want candidate versions checked against OSV, so that public vulnerability data affects resolution.
2. As a Pyloros user, I want candidate versions cross-checked with the npm advisory endpoint, so that registry-native advisories are not missed.
3. As a Pyloros user, I want the two sources unioned and deduplicated by advisory identifier, so that one vulnerability is not counted twice.
4. As a Pyloros user, I want severity normalized across sources, so that reporting is consistent.
5. As a Pyloros user, I want every severity to block by default, so that low-severity advisories are not silently ignored.
6. As a Pyloros user, I want npm advisories filtered by their vulnerable version range, so that an advisory for another version is not applied.
7. As a Pyloros user, I want an unparseable vulnerable range treated as affecting the version, so that malformed advisory data fails safe.
8. As a Pyloros user, I want advisory data cached per identity, so that resolution does not re-query the same versions repeatedly.
9. As a Pyloros user, I want cached advisory data to expire, so that new disclosures are picked up.
10. As a Pyloros user, I want stale or unreachable advisory data to block resolution, so that a missing network cannot silently weaken the check.
11. As a Pyloros user, I want a fresh cache to remain usable while the network is down, so that short outages do not break deterministic work.
12. As a Pyloros user, I want the highest advisory-free version selected, so that resolution prefers current secure code.
13. As a Pyloros user, I want a lower clean version selected over a higher affected one, so that security wins over recency.
14. As a Pyloros user, I want an affected version never selected automatically, so that accepting a vulnerability is always deliberate.
15. As a Pyloros user, I want a Fallback Selection when every range-satisfying version is affected, so that I am not stuck.
16. As a Pyloros user, I want the fallback list to show every contract-compatible version with its advisories, so that I can compare risk.
17. As a Pyloros user, I want advisory links in the fallback list, so that I can read the details before deciding.
18. As a Pyloros user, I want terminal hyperlinks where supported and raw URLs otherwise, so that the links work in any terminal.
19. As a Pyloros user, I want no default selection, so that pressing Enter alone aborts instead of accidentally accepting risk.
20. As a Pyloros user, I want to type the exact `name@version`, so that a mistaken keystroke cannot choose a package.
21. As a Pyloros user, I want an override reason required, so that every exception is explainable.
22. As a Pyloros user, I want an Override Pin recorded with the constraints it bypassed and the advisory identifiers, so that the decision is auditable.
23. As a Pyloros user, I want choosing an affected version to require an explicit override switch, so that accepting a known vulnerability is a separate deliberate action.
24. As a Pyloros user, I want choosing a clean version outside the declared ranges to be allowed through the same mechanism, so that a conflict can be resolved manually.
25. As a Pyloros user, I want a fallback selection for a conflict discovered before selection, so that incompatible ranges can be resolved interactively.
26. As a Pyloros user, I want the Advisory Snapshot to contain only advisories for selected versions, so that the record is pruned and reviewable.
27. As a Pyloros user, I want snapshot sources and timestamp recorded, so that a past resolution can be understood.
28. As a Pyloros user, I want advisory decisions deterministic, so that repeated resolutions produce the same result.
29. As a maintainer, I want advisory sources injected as a provider, so that tests use fake advisories without network access.

## Implementation Decisions

- Advisory data has a common shape: identifier, package, normalized severity, URL, optional summary, and optional aliases. Severities are low, moderate, high, critical, and unknown.
- OSV is queried through its batch endpoint in chunks, with npm as the package ecosystem. npm advisories are queried through the registry bulk endpoint grouped by package name.
- Results are merged by identifier. When the same identifier appears in both sources, the higher severity wins and summaries and aliases are combined.
- OSV severity comes from the advisory's database-specific severity field. Unrecognized or missing severity becomes unknown.
- npm advisories are applied to a version only when that version satisfies the advisory's vulnerable range. An invalid range is treated as affecting the version.
- The advisory service caches each Package Identity for 24 hours by default. The cache is a single JSON file in the cache directory, written atomically. A corrupt cache is treated as empty.
- A query reuses fresh cache entries and batch-fetches only stale or missing identities. Both sources are consulted for stale identities.
- Either source failing aborts the query. OSV failures surface as advisory errors; npm endpoint failures surface through the registry error path. Both fail closed.
- The service returns both per-identity advisories and a snapshot containing the timestamp, consulted sources, and only non-empty identity entries.
- The resolver queries advisories only for versions that satisfy the current hard constraints. This keeps normal resolutions cheap and keeps the snapshot pruned.
- Clean range-satisfying candidates are selected highest first. If none are clean, and a fallback selector exists, the resolver queries advisories for every contract-compatible version to build the fallback list.
- Fallback candidates carry the version, advisories, whether the version satisfies the constraints, and deprecation status. Versions that violate the Runtime Contract are excluded because that contract is never overridable.
- Without a fallback selector, an all-affected candidate set throws the advisory error. A pure range conflict throws the resolution-conflict error.
- A fallback choice is validated against available contract-compatible versions. An empty reason is rejected. Choosing an affected version without the advisory override switch is rejected with the advisory error.
- An accepted fallback choice is recorded as an Override Pin with Package Identity, version, reason, creation timestamp, advisory identifiers, and the constraint sources that were waived. The overridden identity is exempt from later range checks for the rest of that resolution.
- The resolver's final Advisory Snapshot is built from the selected tree, not from every version queried, so it is pruned to the Pins that matter.
- The interactive selector prints the fallback list, prompts for an exact selection, rejects an affected choice when the override switch is off, then prompts for a reason. Empty input aborts. Terminal hyperlinks are emitted only when the output is a TTY.
- Conflict fallback is available when the conflict is known at selection time. A conflict discovered after a version was already selected still fails with the resolution-conflict error; this is a known limitation rather than intended behaviour.

## Testing Decisions

- The resolver is tested through its public entry point with a fake packument provider and a fake advisory provider. Assertions cover selected versions, overrides, snapshot contents, and exit-coded errors.
- Advisory service tests use a fake fetch implementation that routes OSV and npm endpoints, allowing deterministic control of results, failures, and call counts.
- Service tests cover union and normalization, npm range filtering, TTL reuse, stale refresh, fresh-cache offline use, and fail-closed behaviour with an uncached failure.
- Resolver tests cover skipping an affected highest version, fallback when all satisfying versions are affected, fail-closed without a selector, refusal of an affected override without the switch, acceptance with the switch, conflict fallback when known at selection time, and conflict failure without a selector.
- Fallback formatting tests cover plain URLs, OSC 8 hyperlinks, exact selection parsing, wrong package names, unknown versions, and empty input.
- Prior art: fake providers, exit-coded error assertions, and cached-service tests with deterministic clocks.

## Out of Scope

- Persisting the Advisory Snapshot and Override Pins into a lockfile; that is the lockfile stage.
- Wiring the interactive selector into CLI commands.
- Severity thresholds, advisory expiry policy beyond the cache TTL, and suppression lists beyond the advisory override switch.
- Post-selection conflict fallback.
- Withdrawn or disputed advisories.

## Further Notes

- The snapshot is built from selected versions so the lockfile does not balloon with advisories for versions the user never chose.
- Excluding contract-violating versions from the fallback list is deliberate: the Runtime Contract is mandatory, so offering those versions would offer an impossible choice.
- The post-selection conflict limitation is tracked for a later milestone and does not affect advisory-driven fallback.
