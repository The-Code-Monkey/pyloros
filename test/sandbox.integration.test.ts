import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLockfile } from "../src/core/lockfile.ts";
import { parseProjectManifest } from "../src/core/manifest.ts";
import type { ProvenanceVerifier } from "../src/gate/types.ts";
import { BubblewrapSandbox } from "../src/gate/sandbox.ts";
import { sha512Sri } from "../src/registry/integrity.ts";
import type { VersionManifest } from "../src/registry/packument.ts";
import type { Resolution } from "../src/resolve/resolver.ts";
import { ContentStore } from "../src/store/cas.ts";
import { materialize } from "../src/store/materialize.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import { makeTar } from "./helpers/tar.ts";

const PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" } as const;

class VerifiedProvenance implements ProvenanceVerifier {
  async verify() {
    return {
      status: "verified" as const,
      attestationDigest: "digest",
      subjectIntegrity: "sha512-subject",
      verifiedAt: FIXED_SNAPSHOT,
    };
  }
}

class FakeTarballs {
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  async getTarball(): Promise<Uint8Array> {
    return this.data;
  }
}

test(
  "runs an allowlisted script inside real bubblewrap",
  async (context) => {
    if (!(await new BubblewrapSandbox().available())) {
      context.skip("bubblewrap is not installed");
      return;
    }

    const directory = await mkdtemp(join(tmpdir(), "pyloros-bwrap-"));
    const store = new ContentStore(join(directory, "store"));
    const poison = JSON.stringify(join(store.root, "poison"));
    const script = `echo hello > ran.txt; echo poison > ${poison} 2>/dev/null || true`;
    const data = makeTar([
      { name: "package/index.js", data: "alpha" },
      { name: "package/script.sh", data: script },
    ]);
    const version = "1.0.0";
    const manifest: VersionManifest = {
      name: "alpha",
      version,
      engines: { node: ">=18" },
      dist: {
        tarball: "https://registry.example/alpha/-/alpha-1.0.0.tgz",
        integrity: sha512Sri(data),
      },
      scripts: { install: script },
    };
    const resolution: Resolution = {
      nodeVersion: "24.14.1",
      packages: [{ name: "alpha", version, manifest }],
      advisories: { snapshotAt: FIXED_SNAPSHOT, sources: [], entries: {} },
      overrides: [],
    };
    const project = parseProjectManifest(directory, {
      name: "fixture",
      dependencies: { alpha: "1.0.0" },
    });
    const lockfile = createLockfile(project, resolution, { nodeAbi: "137" });

    try {
      const result = await materialize({
        projectDirectory: directory,
        lockfile,
        registry: new FakeTarballs(data),
        store,
        platform: PLATFORM,
        policy: {
          allowScripts: { "alpha@1.0.0": { reason: "integration" } },
          pins: {},
          allowAdvisories: [],
        },
        provenance: new VerifiedProvenance(),
        sandbox: new BubblewrapSandbox(),
        scriptTimeoutMs: 30_000,
      });

      assert.deepEqual(result.gate.packages[0]?.scripts, [
        { name: "install", action: "executed" },
      ]);

      const written = await stat(
        join(directory, "node_modules", "alpha", "ran.txt"),
      );
      assert.ok(written.isFile());

      await assert.rejects(stat(join(store.root, "poison")), /ENOENT/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
