# Split tar decoding from extraction policy

Status: ready-for-agent
Recorded: 2026-11-11

## Problem Statement

The tar module exposes one narrow, deep interface, but its implementation fuses archive decoding with security policy. Checksum handling, PAX records and GNU long names sit beside path normalization, link rejection, size limits and mode sanitization. Mode policy is invisible in the returned entry shape, and the tar reader's parser fidelity paths, PAX, long names and size limits have no direct tests. Any change to wire parsing risks the safety policy and vice versa.

## Solution

Split the implementation into a raw decoder and a policy pass. The decoder faithfully parses the archive and enforces only wire validity and decompression bounds. The policy pass applies path rules, entry-type rules, per-file and total size limits, and mode sanitization. The public `extractTar` interface stays unchanged and composes both.

## User Stories

1. As a Pyloros user, I want archive parsing to stay strict, so that malformed headers are still rejected.
2. As a Pyloros user, I want PAX path records still honored, so that long paths from real packages install.
3. As a Pyloros user, I want GNU long names still honored, so that real archives remain compatible.
4. As a Pyloros user, I want absolute paths rejected, so that extraction cannot escape the archive root.
5. As a Pyloros user, I want parent-directory escapes rejected, so that extraction cannot overwrite outside the package.
6. As a Pyloros user, I want drive prefixes, backslashes and NUL bytes rejected, so that cross-platform confusion cannot become a path escape.
7. As a Pyloros user, I want symlinks, hardlinks and device entries rejected, so that archives cannot smuggle files outside the package.
8. As a Pyloros user, I want duplicate entries rejected, so that ambiguous archives cannot overwrite earlier content.
9. As a Pyloros user, I want per-file and total expansion limits, so that a hostile archive cannot fill the disk.
10. As a Pyloros user, I want executable bits preserved for native artifacts, so that Platform Variants can run.
11. As a Pyloros user, I want setuid, setgid and sticky bits stripped, so that archive permissions cannot escalate.
12. As a Pyloros user, I want non-executable files normalized to regular permissions, so that unpredictable modes do not leak.
13. As a Pyloros user, I want the public extraction behavior unchanged, so that the CAS and materialization need no changes.
14. As a maintainer, I want decoder tests, so that checksum, PAX, long-name and truncation paths are covered directly.
15. As a maintainer, I want policy tests, so that path, type, size and mode rules are covered without handcrafting archives.
16. As a maintainer, I want the public extraction interface to keep composing both, so that callers learn nothing new.
17. As a maintainer, I want decoder and policy to be internal seams, so that the module does not expose two public interfaces.
18. As a maintainer, I want mode policy to be explicit in the entry shape, so that the CAS does not assume hidden normalization.
19. As a maintainer, I want bounded decompression to stay in the decoder, so that policy never sees unbounded output.
20. As a maintainer, I want the split to be behaviour-preserving, so that existing tar tests continue to pass unchanged.

## Implementation Decisions

- An internal raw decoder parses gzip decompression, 512-byte headers, checksums, ustar prefixes, PAX path records and GNU long names. It enforces decompression and structural bounds but does not apply path or entry-type policy.
- An internal policy pass converts raw entries into extraction entries. It applies path normalization, type rejection, duplicate rejection, per-file and total size limits and mode sanitization.
- Mode policy normalizes executable files to `0755` and other files to `0644`, stripping setuid, setgid and sticky bits. Directory modes remain `0755`.
- The public `extractTar` interface is unchanged and composes decode and sanitize. No second public interface is introduced.
- Decompression bounds stay with decoding. Expansion and per-entry limits stay with policy.
- CAS and materialization continue to consume extraction entries without knowing the internal split.
- No behaviour change is intended.

## Testing Decisions

- A good test uses the decode interface for wire fidelity and the sanitize interface for policy, or crosses `extractTar` for composition.
- Decoder tests cover valid headers, compressed and uncompressed input, checksum failure, truncation, empty archives, PAX path override, GNU long names and unsupported entry types.
- Policy tests cover absolute paths, traversal, backslashes, drive prefixes, NUL bytes, duplicate entries, link rejection, per-file limits, total limits and mode normalization.
- Existing `extractTar` tests remain as composition checks.
- Prior art: the in-process tar builder and the existing tar tests.

## Out of Scope

- New archive formats, streaming extraction or compression other than gzip.
- Changing the Store or materialization interface.
- Changing extraction performance characteristics.
- Trusting additional archive entry types.

## Further Notes

- This candidate is speculative because the public interface is already deep and there is one caller. The gain is testability of parser fidelity and safety policy separately, not leverage across callers.
- The internal split is justified only if the tests actually target the two seams. Otherwise it moves code without deepening.
