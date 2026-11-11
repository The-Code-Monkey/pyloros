# Give the lockfile one codec and a smaller interface

Status: ready-for-agent
Recorded: 2026-11-11

## Problem Statement

The lockfile module owns wire schema, deep validation, projection from a resolution, integrity normalization, advisory and Gate and provenance schema, and atomic file IO. Creation and parsing each know the schema independently. Gate and provenance validation run twice per record. The module exports seven entry points and imports Override Pin types from the resolver, creating a dependency from persistence back into resolution.

## Solution

Keep the public lockfile interface small: read, write and create from a resolution. Hide decoding and encoding behind one codec module that owns each direction of the schema. Keep projection from a resolution separate from the codec. Move the Override Pin shape into the lockfile domain so persistence no longer imports the resolver.

## User Stories

1. As a maintainer, I want one codec to own lockfile decoding, so that validation rules have locality.
2. As a maintainer, I want one codec to own lockfile encoding, so that canonical form is guaranteed in one place.
3. As a maintainer, I want projection from a resolution to stay separate from the codec, so that resolution changes do not touch wire validation.
4. As a maintainer, I want Gate records validated once per package, so that duplicate parsing cannot diverge.
5. As a maintainer, I want provenance records validated once per package, so that duplicate parsing cannot diverge.
6. As a maintainer, I want the lockfile module to stop importing resolver types, so that persistence does not depend on resolution internals.
7. As a maintainer, I want a small public lockfile interface, so that callers learn three entry points rather than seven.
8. As a maintainer, I want read and write to remain the IO seam, so that temporary files and atomic rename stay inside one module.
9. As a Pyloros user, I want canonical JSON output to stay byte-identical, so that lockfile diffs do not change.
10. As a Pyloros user, I want malformed lockfiles rejected as before, so that a hand-edited file cannot widen permissions.
11. As a Pyloros user, I want unsupported schema versions rejected, so that future migrations stay explicit.
12. As a Pyloros user, I want Gate records rejected when they allow undeclared scripts, so that tampering stays caught.
13. As a Pyloros user, I want verified provenance records rejected without digest, subject and timestamp, so that incomplete trust records fail.
14. As a Pyloros user, I want Override Pins preserved through round-trip, so that advisory exceptions survive reproduction.
15. As a Pyloros user, I want a missing lockfile to read as absent, so that install can bootstrap.
16. As a Pyloros user, I want a no-op write to produce identical bytes, so that tooling does not create noise.
17. As a maintainer, I want existing schema tests kept at the public interface, so that they do not test private helpers.
18. As a maintainer, I want IO tests separate from schema tests, so that filesystem failures do not obscure validation failures.
19. As a maintainer, I want projection tests separate from decode tests, so that resolution shape changes are localized.
20. As a maintainer, I want lockfile types to be self-contained, so that imports flow one direction.

## Implementation Decisions

- The public lockfile interface is read, write and create-from-resolution. Parsing and serialization are implementation details reachable through read and write.
- A codec module inside the lockfile implementation owns decode and encode. Decode validates and produces the Lockfile value; encode produces canonical JSON.
- Projection from a resolution stays a separate concern. It normalizes integrity, copies package fields and builds the root specification block.
- Gate and provenance records are decoded once per package and reused for validation and result construction.
- The Override Pin shape moves into the lockfile domain or a shared domain module. The resolver imports it from there instead of the reverse.
- Schema version, canonical key ordering, trailing newline, atomic rename and missing-file behavior remain unchanged.
- Read and write remain the only filesystem-facing interface.
- No schema change and no behaviour change are intended.

## Testing Decisions

- A good test crosses read, write or create, or the codec's single interface where an internal seam is explicitly under test. It asserts values and bytes, not helper calls.
- Tests cover canonical round-trip, byte stability, missing file, malformed JSON, unsupported version, package name and key mismatch, invalid URL, Gate record tampering, provenance record tampering, Override Pin round-trip and advisory snapshot validation.
- IO tests use temporary directories and assert file names, atomic replacement and missing-file behavior.
- Projection tests build a resolution and assert every recorded field.
- Prior art: the existing lockfile round-trip and tamper tests, temporary directories and canonical JSON comparisons.

## Out of Scope

- Schema version changes, migrations or a binary format.
- Changing lockfile field names or adding new policy fields.
- Reworking resolution or Gate record production.
- Cache or Store persistence.

## Further Notes

- The resolver-to-lockfile type import is the clearest sign that Override Pin is domain vocabulary, not resolver-private state. The glossary already names it.
- This candidate is worth exploring rather than strong because the public behaviour is already correct; the gain is locality and a smaller interface.
- The codec is an internal seam with one caller today. It does not justify a second public seam.
