import assert from "node:assert/strict";
import { test } from "node:test";
import { ManifestError } from "../src/core/errors.ts";
import {
  parseProjectManifest,
  readProjectManifest,
} from "../src/core/manifest.ts";
import { fileURLToPath } from "node:url";

test("parses the real-world fixture", async () => {
  const directory = fileURLToPath(new URL("./fixtures/real-world", import.meta.url));
  const manifest = await readProjectManifest(directory);

  assert.deepEqual(manifest.dependencies, {
    commander: "15.1.0",
    kleur: "4.1.5",
    semver: "7.8.6",
  });
  assert.deepEqual(manifest.policy, {
    allowScripts: {},
    pins: {},
    allowAdvisories: [],
  });
});

test("rejects non-registry dependency specifiers", () => {
  assert.throws(
    () =>
      parseProjectManifest(".", {
        dependencies: { local: "file:../local" },
      }),
    ManifestError,
  );

  assert.throws(
    () =>
      parseProjectManifest(".", {
        dependencies: { remote: "git+https://example.invalid/repo.git" },
      }),
    ManifestError,
  );
});

test("rejects invalid semver ranges", () => {
  assert.throws(
    () => parseProjectManifest(".", { dependencies: { broken: "not a range" } }),
    ManifestError,
  );
});

test("requires a reason on every allowScripts entry", () => {
  assert.throws(
    () =>
      parseProjectManifest(".", {
        pyloros: { allowScripts: { "pkg@1.0.0": {} } },
      }),
    ManifestError,
  );
});

test("requires exact versions in pins", () => {
  assert.throws(
    () =>
      parseProjectManifest(".", {
        pyloros: { pins: { pkg: "^1.0.0" } },
      }),
    ManifestError,
  );
});

test("parses policy entries", () => {
  const manifest = parseProjectManifest(".", {
    pyloros: {
      allowScripts: { "pkg@1.0.0": { reason: "native build" } },
      pins: { other: "2.0.0" },
      allowAdvisories: ["GHSA-xxxx"],
    },
  });

  assert.deepEqual(manifest.policy.allowScripts, {
    "pkg@1.0.0": { reason: "native build" },
  });
  assert.deepEqual(manifest.policy.pins, { other: "2.0.0" });
  assert.deepEqual(manifest.policy.allowAdvisories, ["GHSA-xxxx"]);
});

test("parses devDependencies", () => {
  const manifest = parseProjectManifest(".", {
    devDependencies: { tool: "1.0.0" },
  });

  assert.deepEqual(manifest.devDependencies, { tool: "1.0.0" });
});

test("rejects non-registry devDependency specifiers", () => {
  assert.throws(
    () =>
      parseProjectManifest(".", {
        devDependencies: { tool: "file:../tool" },
      }),
    ManifestError,
  );
});
