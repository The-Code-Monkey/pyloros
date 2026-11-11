import assert from "node:assert/strict";
import { test } from "node:test";
import { ResolutionError, RuntimeContractError } from "../src/core/errors.ts";
import { resolve } from "../src/resolve/resolver.ts";
import {
  FakeRegistry,
  packageDoc,
  projectManifest,
  version,
} from "./helpers/registry.ts";

const NODE = "24.14.1";

function identities(packages: readonly { name: string; version: string }[]): string[] {
  return packages.map((entry) => `${entry.name}@${entry.version}`);
}

test("selects the highest version satisfying every range", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [
      version("a", "1.0.0"),
      version("a", "1.2.0"),
      version("a", "2.0.0"),
    ]),
    packageDoc("b", [version("b", "1.0.0", { dependencies: { a: "^1.1.0" } })]),
  ]);

  const result = await resolve(
    projectManifest({ a: "^1.0.0", b: "1.0.0" }),
    registry,
    { nodeVersion: NODE },
  );

  assert.deepEqual(identities(result.packages), ["a@1.2.0", "b@1.0.0"]);
});

test("collapses transitive ranges onto one version", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [
      version("a", "1.0.0"),
      version("a", "1.4.0"),
      version("a", "1.9.0"),
      version("a", "2.0.0"),
    ]),
    packageDoc("b", [version("b", "1.0.0", { dependencies: { a: ">=1.2.0" } })]),
    packageDoc("c", [version("c", "1.0.0", { dependencies: { a: "<1.5.0" } })]),
  ]);

  const result = await resolve(
    projectManifest({ a: "^1.0.0", b: "1.0.0", c: "1.0.0" }),
    registry,
    { nodeVersion: NODE },
  );

  assert.deepEqual(identities(result.packages), ["a@1.4.0", "b@1.0.0", "c@1.0.0"]);
});

test("fails when no single version satisfies all ranges", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "1.0.0"), version("a", "2.0.0")]),
    packageDoc("b", [version("b", "1.0.0", { dependencies: { a: "^2.0.0" } })]),
  ]);

  await assert.rejects(
    resolve(projectManifest({ a: "^1.0.0", b: "1.0.0" }), registry, {
      nodeVersion: NODE,
    }),
    ResolutionError,
  );
});

test("backtracks to a lower version to satisfy a shared dependency", async () => {
  const registry = new FakeRegistry([
    packageDoc("app", [
      version("app", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      version("app", "2.0.0", { dependencies: { shared: "^2.0.0" } }),
    ]),
    packageDoc("tool", [
      version("tool", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      version("tool", "2.0.0", { dependencies: { shared: "^1.0.0" } }),
    ]),
    packageDoc("shared", [
      version("shared", "1.0.0"),
      version("shared", "1.5.0"),
      version("shared", "2.0.0"),
    ]),
  ]);

  const result = await resolve(
    projectManifest({ app: "*", tool: "*" }),
    registry,
    { nodeVersion: NODE },
  );

  assert.deepEqual(identities(result.packages), [
    "app@1.0.0",
    "shared@1.5.0",
    "tool@2.0.0",
  ]);
});

test("skips versions that violate the Runtime Contract", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [
      version("a", "1.0.0", { engines: { node: ">=18" } }),
      version("a", "2.0.0", { engines: { node: ">=99" } }),
    ]),
  ]);

  const result = await resolve(projectManifest({ a: "*" }), registry, {
    nodeVersion: NODE,
  });

  assert.deepEqual(identities(result.packages), ["a@1.0.0"]);
});

test("fails with the contract code when every version violates it", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [
      version("a", "1.0.0", { engines: { node: ">=99" } }),
      version("a", "2.0.0", { engines: {} }),
    ]),
  ]);

  await assert.rejects(
    resolve(projectManifest({ a: "*" }), registry, { nodeVersion: NODE }),
    RuntimeContractError,
  );
});

test("installs a required peer as a single version", async () => {
  const registry = new FakeRegistry([
    packageDoc("plugin", [
      version("plugin", "1.0.0", { peerDependencies: { host: "^2.0.0" } }),
    ]),
    packageDoc("host", [version("host", "2.0.0"), version("host", "2.1.0")]),
  ]);

  const result = await resolve(projectManifest({ plugin: "1.0.0" }), registry, {
    nodeVersion: NODE,
  });

  assert.deepEqual(identities(result.packages), ["host@2.1.0", "plugin@1.0.0"]);
});

test("treats peer ranges as hard constraints", async () => {
  const registry = new FakeRegistry([
    packageDoc("plugin", [
      version("plugin", "1.0.0", { peerDependencies: { host: "^2.0.0" } }),
    ]),
    packageDoc("host", [version("host", "1.5.0"), version("host", "2.1.0")]),
  ]);

  await assert.rejects(
    resolve(projectManifest({ plugin: "1.0.0", host: "^1.0.0" }), registry, {
      nodeVersion: NODE,
    }),
    ResolutionError,
  );
});

test("does not install an absent optional peer", async () => {
  const registry = new FakeRegistry([
    packageDoc("plugin", [
      version("plugin", "1.0.0", {
        peerDependencies: { host: "^2.0.0" },
        peerDependenciesMeta: { host: { optional: true } },
      }),
    ]),
  ]);

  const result = await resolve(projectManifest({ plugin: "1.0.0" }), registry, {
    nodeVersion: NODE,
  });

  assert.deepEqual(identities(result.packages), ["plugin@1.0.0"]);
});

test("enforces an optional peer range when the peer is present", async () => {
  const registry = new FakeRegistry([
    packageDoc("plugin", [
      version("plugin", "1.0.0", {
        peerDependencies: { host: "^2.0.0" },
        peerDependenciesMeta: { host: { optional: true } },
      }),
    ]),
    packageDoc("host", [version("host", "1.5.0"), version("host", "2.1.0")]),
  ]);

  await assert.rejects(
    resolve(projectManifest({ plugin: "1.0.0", host: "^1.0.0" }), registry, {
      nodeVersion: NODE,
    }),
    ResolutionError,
  );
});

test("resolves dependency cycles", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "1.0.0", { dependencies: { b: "^1.0.0" } })]),
    packageDoc("b", [version("b", "1.0.0", { dependencies: { a: "^1.0.0" } })]),
  ]);

  const result = await resolve(projectManifest({ a: "^1.0.0" }), registry, {
    nodeVersion: NODE,
  });

  assert.deepEqual(identities(result.packages), ["a@1.0.0", "b@1.0.0"]);
});

test("is deterministic", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "1.0.0"), version("a", "1.1.0")]),
    packageDoc("b", [
      version("b", "1.0.0", { dependencies: { a: "^1.0.0" } }),
    ]),
  ]);
  const manifest = projectManifest({ a: "*", b: "*" });

  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const first = await resolve(manifest, registry, { nodeVersion: NODE, now });
  const second = await resolve(manifest, registry, { nodeVersion: NODE, now });

  assert.deepEqual(first, second);
});

test("prefers a locked version when it still satisfies the ranges", async () => {
  const registry = new FakeRegistry([
    packageDoc("a", [version("a", "1.0.0"), version("a", "1.5.0")]),
  ]);

  const result = await resolve(projectManifest({ a: "*" }), registry, {
    nodeVersion: NODE,
    preferred: { a: "1.0.0" },
  });

  assert.deepEqual(identities(result.packages), ["a@1.0.0"]);
});
