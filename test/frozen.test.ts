import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FrozenDriftError,
  RuntimeContractError,
} from "../src/core/errors.ts";
import { assertFrozen, frozenDrifts } from "../src/core/frozen.ts";
import { createLockfile } from "../src/core/lockfile.ts";
import { parseProjectManifest } from "../src/core/manifest.ts";
import type { Resolution } from "../src/resolve/resolver.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import { version } from "./helpers/registry.ts";

const NODE = "24.14.1";
const ABI = "137";

function manifest(dependencies: Record<string, string> = { a: "^1.0.0" }) {
  return parseProjectManifest("/project", { name: "fixture", dependencies });
}

function resolution(): Resolution {
  return {
    nodeVersion: NODE,
    packages: [
      { name: "a", version: "1.2.0", manifest: version("a", "1.2.0") },
    ],
    advisories: { snapshotAt: FIXED_SNAPSHOT, sources: [], entries: {} },
    overrides: [],
  };
}

function lockfile(dependencies: Record<string, string> = { a: "^1.0.0" }) {
  return createLockfile(manifest(dependencies), resolution(), { nodeAbi: ABI });
}

test("accepts a matching lockfile", () => {
  assert.doesNotThrow(() =>
    assertFrozen(manifest(), lockfile(), { nodeVersion: NODE, nodeAbi: ABI }),
  );
});

test("reports a Node version drift with exit code 4", () => {
  const error = (() => {
    try {
      assertFrozen(manifest(), lockfile(), { nodeVersion: "25.0.0", nodeAbi: ABI });
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();

  assert.ok(error instanceof RuntimeContractError);
  assert.equal(error.exitCode, 4);
  assert.match(error.message, /resolved for Node 24\.14\.1/);
});

test("reports an ABI drift with exit code 4", () => {
  const drifts = frozenDrifts(manifest(), lockfile(), {
    nodeVersion: NODE,
    nodeAbi: "999",
  });

  assert.deepEqual(drifts.map((drift) => drift.kind), ["node-abi"]);
});

test("reports changed root specs with exit code 7", () => {
  const error = (() => {
    try {
      assertFrozen(manifest({ a: "^2.0.0" }), lockfile(), {
        nodeVersion: NODE,
        nodeAbi: ABI,
      });
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();

  assert.ok(error instanceof FrozenDriftError);
  assert.equal(error.exitCode, 7);
  assert.match(error.message, /differ from the lockfile/);
});

test("reports a missing root package", () => {
  const drifts = frozenDrifts(manifest({ other: "^1.0.0" }), lockfile(), {
    nodeVersion: NODE,
    nodeAbi: ABI,
  });

  assert.ok(drifts.some((drift) => drift.kind === "missing-package"));
});

test("reports a locked version outside the root range", () => {
  const locked = lockfile();
  locked.packages["a"] = { ...locked.packages["a"]!, version: "0.9.0" };

  const drifts = frozenDrifts(manifest({ a: "^1.0.0" }), locked, {
    nodeVersion: NODE,
    nodeAbi: ABI,
  });

  assert.ok(drifts.some((drift) => drift.kind === "unsatisfied-root"));
});

test("node drift takes precedence over root drift", () => {
  assert.throws(
    () =>
      assertFrozen(manifest({ a: "^2.0.0" }), lockfile(), {
        nodeVersion: "25.0.0",
        nodeAbi: ABI,
      }),
    RuntimeContractError,
  );
});
