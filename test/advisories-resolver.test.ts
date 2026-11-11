import assert from "node:assert/strict";
import { test } from "node:test";
import { AdvisoryError, ResolutionError } from "../src/core/errors.ts";
import {
  resolve,
  type FallbackRequest,
  type FallbackSelector,
} from "../src/resolve/resolver.ts";
import { advisory, FakeAdvisories, FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import {
  FakeRegistry,
  packageDoc,
  projectManifest,
  version,
} from "./helpers/registry.ts";

const NODE = "24.14.1";

function fixedNow(): Date {
  return new Date(FIXED_SNAPSHOT);
}

function identities(packages: readonly { name: string; version: string }[]): string[] {
  return packages.map((entry) => `${entry.name}@${entry.version}`);
}

test("skips an affected version and selects the highest clean one", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "1.0.0"), version("a", "1.1.0")]),
  ]);
  const advisories = new FakeAdvisories({
    "a@1.1.0": [advisory("GHSA-1")],
  });

  const result = await resolve(projectManifest({ a: "^1.0.0" }), registry, {
    nodeVersion: NODE,
    advisoryProvider: advisories,
    now: fixedNow,
  });

  assert.deepEqual(identities(result.packages), ["a@1.0.0"]);
  assert.deepEqual(result.advisories.entries, {});
  assert.deepEqual(result.advisories.sources, ["npm", "osv"]);
  assert.deepEqual(result.overrides, []);
});

test("asks for a fallback when every satisfying version is affected", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "1.5.0"), version("a", "2.0.0")]),
  ]);
  const advisories = new FakeAdvisories({
    "a@2.0.0": [advisory("GHSA-2")],
  });
  let seen: FallbackRequest | undefined;
  const fallback: FallbackSelector = async (request) => {
    seen = request;
    return { version: "1.5.0", reason: "prefer the clean version" };
  };

  const result = await resolve(projectManifest({ a: "^2.0.0" }), registry, {
    nodeVersion: NODE,
    advisoryProvider: advisories,
    fallback,
    now: fixedNow,
  });

  assert.deepEqual(identities(result.packages), ["a@1.5.0"]);
  assert.equal(result.overrides.length, 1);
  assert.equal(result.overrides[0]?.reason, "prefer the clean version");
  assert.deepEqual(result.overrides[0]?.constraints, ["^2.0.0 (<root>)"]);
  assert.deepEqual(result.overrides[0]?.advisoryIds, []);
  assert.equal(result.overrides[0]?.createdAt, FIXED_SNAPSHOT);

  const chosen = seen?.candidates.find((candidate) => candidate.version === "1.5.0");
  assert.equal(chosen?.satisfiesConstraints, false);
  assert.deepEqual(chosen?.advisories, []);
});

test("fails closed without a fallback selector", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "2.0.0")]),
  ]);
  const advisories = new FakeAdvisories({
    "a@2.0.0": [advisory("GHSA-3")],
  });

  await assert.rejects(
    resolve(projectManifest({ a: "*" }), registry, {
      nodeVersion: NODE,
      advisoryProvider: advisories,
      now: fixedNow,
    }),
    AdvisoryError,
  );
});

test("refuses an affected override without allowAdvisories", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "2.0.0")]),
  ]);
  const advisories = new FakeAdvisories({
    "a@2.0.0": [advisory("GHSA-4")],
  });
  const fallback: FallbackSelector = async () => ({
    version: "2.0.0",
    reason: "accepted for now",
  });

  await assert.rejects(
    resolve(projectManifest({ a: "*" }), registry, {
      nodeVersion: NODE,
      advisoryProvider: advisories,
      fallback,
      now: fixedNow,
    }),
    AdvisoryError,
  );
});

test("records an affected override with allowAdvisories", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "2.0.0")]),
  ]);
  const advisories = new FakeAdvisories({
    "a@2.0.0": [advisory("GHSA-5")],
  });
  const fallback: FallbackSelector = async () => ({
    version: "2.0.0",
    reason: "no alternative exists",
  });

  const result = await resolve(projectManifest({ a: "*" }), registry, {
    nodeVersion: NODE,
    advisoryProvider: advisories,
    fallback,
    allowAdvisories: true,
    now: fixedNow,
  });

  assert.deepEqual(identities(result.packages), ["a@2.0.0"]);
  assert.deepEqual(result.overrides[0]?.advisoryIds, ["GHSA-5"]);
});

test("offers a fallback when ranges conflict before selection", async () => {
  const registry = new FakeRegistry([
    packageDoc("m1", [version("m1", "1.0.0", { dependencies: { z: "^1.0.0" } })]),
    packageDoc("m2", [version("m2", "1.0.0", { dependencies: { z: "^2.0.0" } })]),
    packageDoc("z", [version("z", "1.0.0"), version("z", "2.0.0")]),
  ]);
  let seen: FallbackRequest | undefined;
  const fallback: FallbackSelector = async (request) => {
    seen = request;
    return { version: "2.0.0", reason: "pick the newer version" };
  };

  const result = await resolve(projectManifest({ m1: "*", m2: "*" }), registry, {
    nodeVersion: NODE,
    fallback,
    now: fixedNow,
  });

  assert.deepEqual(identities(result.packages), ["m1@1.0.0", "m2@1.0.0", "z@2.0.0"]);
  assert.equal(seen?.name, "z");
  assert.deepEqual(
    seen?.candidates.map((candidate) => candidate.satisfiesConstraints),
    [false, false],
  );
  assert.equal(result.overrides[0]?.name, "z");
});

test("fails with a conflict when no fallback selector exists", async () => {
  const registry = new FakeRegistry([
    packageDoc("m1", [version("m1", "1.0.0", { dependencies: { z: "^1.0.0" } })]),
    packageDoc("m2", [version("m2", "1.0.0", { dependencies: { z: "^2.0.0" } })]),
    packageDoc("z", [version("z", "1.0.0"), version("z", "2.0.0")]),
  ]);

  await assert.rejects(
    resolve(projectManifest({ m1: "*", m2: "*" }), registry, {
      nodeVersion: NODE,
      now: fixedNow,
    }),
    ResolutionError,
  );
});
