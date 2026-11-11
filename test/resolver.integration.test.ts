import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readProjectManifest } from "../src/core/manifest.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { resolve } from "../src/resolve/resolver.ts";

const enabled = process.env.PYLOROS_NETWORK === "1";

test(
  "resolves the real-world fixture from the npm registry",
  { skip: enabled ? false : "set PYLOROS_NETWORK=1 to run" },
  async () => {
    const directory = fileURLToPath(new URL("./fixtures/real-world", import.meta.url));
    const manifest = await readProjectManifest(directory);
    const cache = await mkdtemp(join(tmpdir(), "pyloros-resolve-"));
    const client = new RegistryClient({ cacheDir: cache });

    try {
      const result = await resolve(manifest, client, {
        nodeVersion: process.version.replace(/^v/u, ""),
      });

      assert.deepEqual(
        result.packages.map((entry) => `${entry.name}@${entry.version}`),
        ["commander@15.1.0", "kleur@4.1.5", "semver@7.8.6"],
      );
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  },
);
