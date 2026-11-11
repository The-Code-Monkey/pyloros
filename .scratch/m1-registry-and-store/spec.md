# Registry client, metadata cache, integrity, and Store

Status: implemented
Recorded: 2026-11-11

## Problem Statement

A security-first package manager cannot trust the network. It needs to read package metadata, download package tarballs, prove that the bytes match what the registry published, and extract those bytes without letting a malicious archive write outside its own directory. It also needs to avoid re-downloading and re-extracting identical content.

## Solution

Pyloros talks the npm registry protocol directly to the public registry. It fetches abbreviated packuments with conditional requests, caches metadata with ETags, verifies tarballs against Subresource Integrity values or the legacy sha1 shasum, and refuses tarballs served from a different origin. A strict tar reader rejects paths and entry types that could escape the archive root. Verified tarballs and their extracted file trees are stored in a content-addressed Store keyed by the sha512 of the tarball bytes.

## User Stories

1. As a Pyloros user, I want packument metadata fetched from the public npm registry, so that resolution sees the real ecosystem.
2. As a Pyloros user, I want the registry client to request the abbreviated packument form, so that metadata transfers stay small.
3. As a Pyloros user, I want metadata cached with an ETag, so that repeat resolutions do not re-download unchanged packuments.
4. As a Pyloros user, I want conditional requests using ETag and Last-Modified, so that the registry can answer with a cheap not-modified response.
5. As a Pyloros user, I want a corrupt or unreadable metadata cache treated as a miss, so that a damaged cache never blocks work.
6. As a Pyloros user, I want transient registry failures retried with backoff, so that a brief outage does not fail an install.
7. As a Pyloros user, I want each request to have a timeout, so that a hung connection cannot stall forever.
8. As a Pyloros user, I want no authentication and no private registry support in this stage, so that the trust surface stays small.
9. As a Pyloros user, I want packuments validated for the fields Pyloros depends on, so that malformed metadata fails clearly instead of producing a broken tree.
10. As a Pyloros user, I want tarball downloads verified against the registry's Subresource Integrity value, so that tampered bytes are rejected.
11. As a Pyloros user, I want multiple integrity tokens accepted, so that packages publishing several hashes are handled correctly.
12. As a Pyloros user, I want sha512, sha384, sha256, and sha1 supported, so that the long tail of published metadata is usable.
13. As a Pyloros user, I want the legacy sha1 shasum used when no SRI value exists, so that older packages can still be verified.
14. As a Pyloros user, I want a package with no hash at all refused, so that unverifiable bytes never enter the Store.
15. As a Pyloros user, I want comparisons done in constant time, so that verification does not leak timing information.
16. As a Pyloros user, I want a tarball URL served from a different origin refused, so that the registry cannot redirect code delivery to an arbitrary host.
17. As a Pyloros user, I want declared and actual tarball sizes bounded, so that a hostile response cannot exhaust memory.
18. As a Pyloros user, I want gzip decompression bounded, so that a decompression bomb cannot exhaust memory.
19. As a Pyloros user, I want tar headers checksum-verified, so that corrupted or crafted headers are rejected early.
20. As a Pyloros user, I want absolute paths, parent-directory escapes, drive prefixes, backslashes, and NUL bytes rejected, so that extraction cannot escape the archive root.
21. As a Pyloros user, I want symlinks and hardlinks rejected, so that extraction cannot smuggle files outside the package directory.
22. As a Pyloros user, I want duplicate entries rejected, so that ambiguous archives cannot overwrite earlier content.
23. As a Pyloros user, I want pax path records and GNU long names handled, so that real packages with long paths still install.
24. As a Pyloros user, I want per-file and total expansion limits, so that a hostile archive cannot fill the disk.
25. As a Pyloros user, I want verified content stored once and reused, so that repeated installs are fast.
26. As a Pyloros user, I want the Store keyed by the sha512 of the actual bytes, so that identity is content-derived rather than metadata-derived.
27. As a Pyloros user, I want Store writes atomic and idempotent, so that concurrent or repeated extraction cannot corrupt the cache.
28. As a Pyloros user, I want the tarball and the extracted tree both kept, so that later installs can link files without re-downloading.
29. As a maintainer, I want tests against a local HTTP fixture registry, so that caching, retry, and verification behaviour is deterministic.

## Implementation Decisions

- The registry base URL defaults to the public npm registry and can be overridden through configuration for tests.
- Packuments are requested with the abbreviated install metadata media type.
- The metadata cache stores the packument, ETag, Last-Modified value, and fetch time. Writes are atomic through a temporary file and rename. Any read or parse failure is treated as a cache miss.
- Requests retry on network errors, 429, and 5xx responses with exponential backoff and a per-attempt timeout. Exhausted retries become a registry error.
- The packument parser validates that each version declares a version string and a tarball URL, and preserves dependencies, optional dependencies, peer dependencies and their optional flags, engines, platform fields, scripts, deprecation status, integrity, and shasum.
- Integrity parsing accepts multiple space-separated tokens and ignores token options. Supported algorithms are sha512, sha384, sha256, and sha1. Digests are compared with a constant-time comparison.
- The legacy shasum path verifies a 40-character hex sha1 digest.
- A tarball with neither an integrity value nor a shasum is refused before extraction.
- The tarball URL's origin must match the configured registry origin. Redirects are followed by the HTTP layer in this stage; the declared URL is still origin-checked.
- The tar reader decompresses gzip with a bounded output size, parses 512-byte headers, verifies header checksums, supports ustar prefixes, pax path records, and GNU long names, and rejects absolute paths, traversal, drive prefixes, backslashes, NUL bytes, duplicate entries, links, device entries, truncation, empty archives, and oversized entries.
- Extraction normalizes leading `./` segments, strips trailing slashes, and ignores file modes from the archive, writing files as regular non-executable files and directories as readable directories.
- The Store is content-addressed by the sha512 hex digest of the tarball. It keeps the original tarball and an extracted tree. Both writes are atomic, and extraction is staged then renamed into place so a failed extraction leaves no partial package directory.
- The Store is explicitly not a trust decision engine: it stores only bytes that already passed registry verification.

## Testing Decisions

- The primary seam is the registry client and the Store, each driven by fixture inputs. Tests assert returned data, thrown exit-coded errors, and resulting filesystem contents.
- A local HTTP fixture server exercises packument fetch, ETag revalidation, tarball verification, integrity mismatch, and cross-origin refusal.
- Unit tests cover integrity parsing, multi-token verification, shasum verification, malformed values, and digest stability.
- Tar tests build archives in-process and cover valid extraction, uncompressed archives, absolute paths, traversal, backslashes, symlinks, duplicates, corrupted checksums, truncation, and empty archives.
- Store tests assert content addressing, tarball presence, extracted file contents, idempotent writes, and refusal of traversing archives.
- Real-registry smoke verification is manual and occasional: fetch and extract a tiny package and a larger package with many paths to confirm compatibility with real npm tarballs.
- Prior art: fixture HTTP servers, in-process archive builders, and filesystem assertions in temporary directories.

## Out of Scope

- Resolution, Runtime Contract checks, advisories, lockfiles, materialization into `node_modules`, and scripts.
- Private registries, authentication, and mirrors.
- Redirect-origin enforcement after the first response.
- Resumable downloads, compression other than gzip, and binary diffing.
- Cache eviction and garbage collection.

## Further Notes

- Real npm tarballs were used to validate the tar reader, including a package with many long paths.
- The origin check is a deliberate narrowing: only the configured registry may deliver tarballs. A future mirror decision would need to revisit it.
- The Store layout is an implementation detail. The glossary term is Store, and later stages treat it as a source of verified package contents.
