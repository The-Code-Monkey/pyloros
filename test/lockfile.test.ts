import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IntegrityError, LockfileError } from "../src/core/errors.ts";
import {
  LOCKFILE_NAME,
  createLockfile,
  parseLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from "../src/core/lockfile.ts";
import { parseProjectManifest } from "../src/core/manifest.ts";
import type { Resolution } from "../src/resolve/resolver.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import { version } from "./helpers/registry.ts";

function manifest(dependencies: Record<string, string> = { a: "1.0.0" }) {
  return parseProjectManifest("/project", { name: "fixture", dependencies });
}

function resolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    nodeVersion: "24.14.1",
    packages: [
      {
        name: "a",
        version: "1.0.0",
        manifest: version("a", "1.0.0", {
          engines: { node: ">=18" },
          scripts: { install: "node build.js", postinstall: "node post.js" },
          peerDependencies: { host: "^1.0.0" },
          os: ["linux"],
          cpu: ["x64"],
          deprecated: "use b",
        }),
      },
    ],
    advisories: { snapshotAt: FIXED_SNAPSHOT, sources: ["osv", "npm"], entries: {} },
    overrides: [],
    ...overrides,
  };
}

test("creates a lockfile from a resolution", () => {
  const lockfile = createLockfile(manifest(), resolution(), {
    toolVersion: "9.9.9",
    nodeAbi: "137",
  });

  assert.equal(lockfile.lockfileVersion, 1);
  assert.equal(lockfile.tool, "pyloros@9.9.9");
  assert.deepEqual(lockfile.node, { version: "24.14.1", abi: "137" });
  assert.deepEqual(lockfile.root, {
    dependencies: { a: "1.0.0" },
    optionalDependencies: {},
  });
  assert.deepEqual(lockfile.packages["a"], {
    name: "a",
    version: "1.0.0",
    integrity: "sha512-AAAA",
    resolved: "https://registry.example/a/-/a-1.0.0.tgz",
    engines: { node: ">=18" },
    os: ["linux"],
    cpu: ["x64"],
    peerDependencies: { host: "^1.0.0" },
    deprecated: "use b",
    scripts: ["install", "postinstall"],
    scriptCommands: {
      install: "node build.js",
      postinstall: "node post.js",
    },
  });
});

test("synthesizes a sha1 integrity from a shasum", () => {
  const shasum = "0".repeat(40);
  const lockfile = createLockfile(
    manifest({ b: "2.0.0" }),
    resolution({
      packages: [
        {
          name: "b",
          version: "2.0.0",
          manifest: version("b", "2.0.0", {
            dist: {
              tarball: "https://registry.example/b/-/b-2.0.0.tgz",
              shasum,
            },
          }),
        },
      ],
    }),
    { nodeAbi: "137" },
  );

  assert.equal(
    lockfile.packages["b"]?.integrity,
    `sha1-${Buffer.from(shasum, "hex").toString("base64")}`,
  );
});

test("refuses to write a package without an integrity hash", () => {
  const lockfile = resolution({
    packages: [
      {
        name: "c",
        version: "1.0.0",
        manifest: version("c", "1.0.0", {
          dist: { tarball: "https://registry.example/c/-/c-1.0.0.tgz" },
        }),
      },
    ],
  });

  assert.throws(
    () => createLockfile(manifest({ c: "1.0.0" }), lockfile, { nodeAbi: "137" }),
    IntegrityError,
  );
});

test("round-trips through canonical serialization", () => {
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });
  const text = serializeLockfile(lockfile);
  const parsed = parseLockfile(JSON.parse(text));

  assert.deepEqual(parsed, lockfile);
  assert.equal(serializeLockfile(parsed), text);
  assert.ok(text.endsWith("\n"));
});

test("writes and reads the lockfile from a directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-lock-"));
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });

  try {
    const path = await writeLockfile(directory, lockfile);
    assert.equal(path, join(directory, LOCKFILE_NAME));

    const text = await readFile(path, "utf8");
    assert.equal(text, serializeLockfile(lockfile));
    assert.deepEqual(await readLockfile(directory), lockfile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns undefined when no lockfile exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-lock-"));

  try {
    assert.equal(await readLockfile(directory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an unsupported lockfile version", () => {
  assert.throws(
    () => parseLockfile({ lockfileVersion: 2 }),
    LockfileError,
  );
});

test("rejects a package whose name does not match its key", () => {
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });
  const value = JSON.parse(serializeLockfile(lockfile)) as {
    packages: Record<string, { name: string }>;
  };
  value.packages["a"]!.name = "b";

  assert.throws(() => parseLockfile(value), LockfileError);
});

test("round-trips Gate and provenance records", () => {
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });
  lockfile.packages["a"] = {
    ...lockfile.packages["a"]!,
    gate: { allowedScripts: ["install"], reason: "native build" },
    provenance: {
      status: "verified",
      attestationDigest: "digest",
      subjectIntegrity: "sha512-subject",
      verifiedAt: FIXED_SNAPSHOT,
    },
  };

  const parsed = parseLockfile(JSON.parse(serializeLockfile(lockfile)));
  assert.deepEqual(parsed, lockfile);
});

test("rejects a Gate record that allows an undeclared script", () => {
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });
  lockfile.packages["a"] = {
    ...lockfile.packages["a"]!,
    gate: { allowedScripts: ["prepublish"], reason: "nope" },
  };

  assert.throws(
    () => parseLockfile(JSON.parse(serializeLockfile(lockfile))),
    LockfileError,
  );
});

test("rejects an empty Gate reason", () => {
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });
  lockfile.packages["a"] = {
    ...lockfile.packages["a"]!,
    gate: { allowedScripts: ["install"], reason: "   " },
  };

  assert.throws(
    () => parseLockfile(JSON.parse(serializeLockfile(lockfile))),
    LockfileError,
  );
});

test("rejects a verified provenance record without its digest", () => {
  const lockfile = createLockfile(manifest(), resolution(), { nodeAbi: "137" });
  lockfile.packages["a"] = {
    ...lockfile.packages["a"]!,
    provenance: { status: "verified" },
  };

  assert.throws(
    () => parseLockfile(JSON.parse(serializeLockfile(lockfile))),
    LockfileError,
  );
});
