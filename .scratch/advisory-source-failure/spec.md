# Define advisory source failure behaviour

Status: ready-for-agent
Recorded: 2026-11-11

## Problem Statement

The advisory provider fans out to OSV and the npm advisory endpoint and fails closed, but partial-source failure has no test and no consistent contract. An OSV failure surfaces as an advisory error while an npm endpoint failure surfaces through a generic registry error. A caller cannot tell whether advisory data was unavailable, malformed or partially returned, and CI can see exit code 1 instead of the advisory block code.

## Solution

Define one advisory-source failure contract at the advisory provider interface. Any source that cannot be consulted makes the advisory lookup unavailable, reported as an advisory failure with the source named. The provider returns either complete unioned data or a typed advisory failure. Add tests for each partial-source failure and malformed response.

## User Stories

1. As a Pyloros user, I want advisory lookup to fail closed when either source is unreachable, so that a missing network cannot silently weaken the check.
2. As a Pyloros user, I want an OSV failure reported as an advisory failure, so that exit code 5 is consistent.
3. As a Pyloros user, I want an npm advisory endpoint failure reported as an advisory failure, so that exit code 1 is not used for a security check.
4. As a Pyloros user, I want the failing source named in the message, so that I can diagnose the outage.
5. As a Pyloros user, I want a malformed source response treated as a failure, so that partial trust is never assumed.
6. As a Pyloros user, I want a fresh cache to remain usable when one source is down, so that cached certainty is not discarded.
7. As a Pyloros user, I want stale cache with a failing source to fail closed, so that old data is never presented as fresh.
8. As a Pyloros user, I want successful union and deduplication unchanged, so that normal advisories behave as before.
9. As a Pyloros user, I want advisory snapshots unchanged on success, so that lockfiles remain stable.
10. As a maintainer, I want one advisory failure type at the provider interface, so that callers do not branch on source-specific errors.
11. As a maintainer, I want the registry adapter's generic error not to escape for advisory lookups, so that error vocabulary stays precise.
12. As a maintainer, I want tests for each partial-source failure, so that fail-closed behaviour is proven.
13. As a maintainer, I want tests for malformed OSV and npm responses, so that validation is proven.
14. As a maintainer, I want the cache path tested with a failing source, so that freshness rules are proven.
15. As a maintainer, I want the provider interface to stay one query operation, so that callers keep one seam.
16. As a maintainer, I want the failure kind to remain advisory, so that resolver and CLI mapping do not change.
17. As a maintainer, I want no new dependency, so that the fan-out stays in-process and testable with fake fetch.
18. As a maintainer, I want existing successful-path tests unchanged, so that the change is localized to failure handling.

## Implementation Decisions

- The advisory provider interface remains one query operation. Callers still receive per-identity advisories and an Advisory Snapshot on success.
- Any source that fails to respond, returns a non-success status or returns a structurally invalid body makes the whole lookup fail closed.
- Both OSV and npm advisory failures are raised as advisory failures, not generic registry failures. The message names the source.
- The resolver continues to map advisory failures to exit code 5. No CLI or resolver interface changes.
- Cache behavior is unchanged: fresh entries are used without a network call; stale or missing entries require both sources; a failure during that fetch fails closed.
- Successful union, deduplication, severity normalization and snapshot construction are unchanged.
- No new adapter or seam is introduced. The existing advisory provider interface is the seam.

## Testing Decisions

- A good test crosses the advisory provider interface with a fake fetch implementation and asserts the thrown failure kind or the successful batch.
- Tests cover OSV failure with npm success, npm failure with OSV success, both failing, malformed OSV body, malformed npm body, fresh cache with one source down, stale cache with one source down and the existing successful union.
- Tests assert the named source and that the failure is an advisory failure.
- Prior art: the existing advisory service tests with a fake fetch and deterministic clock.

## Out of Scope

- Adding a third advisory source or changing severity thresholds.
- Retrying advisory requests beyond existing client behavior.
- Changing caching TTL or snapshot schema.
- Changing SIGSTORE or provenance verification.
- Changing resolver Fallback Selection.

## Further Notes

- This is a small correctness spec, not an architectural deepening. The advisory module is already deep; the missing piece is a consistent failure contract and tests.
- The current npm advisory client's registry error is the concrete bug. Unifying it with advisory errors restores the exit-code contract without changing the provider interface.
