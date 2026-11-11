import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  UsageError,
} from "../src/core/errors.ts";
import {
  readLockfile,
  writeLockfile,
  type Lockfile,
} from "../src/core/lockfile.ts";
import {
  applyDependencyChange,
} from "../src/install/dependency-change.ts";
import { readRawManifest } from "../src/install/manifest-edit.ts";
import type {
  InstallIntent,
  InstallResult,
  InstallSession,
} from "../src/install/install-session.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import { FakeRegistry } from "./helpers/install.ts";
import { version } from "./helpers/registry.ts";

function registryWithLatest(name: string, latest: string): FakeRegistry {
  return new FakeRegistry([
    { name, version: latest, manifest: version(name, latest) },
  ]);
}

function lockfile(
  packages: Record<string, string>,
  dependencies: Record<string, string>,
): Lockfile {
  return {
    lockfileVersion: 1,
    tool: "pyloros@0.0.0",
    node: { version: "24.14.1", abi: "137" },
    root: {
      dependencies,
      optionalDependencies: {},
      devDependencies: {},
    },
    advisories: { snapshotAt: FIXED_SNAPSHOT, sources: [], entries: {} },
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, version]) => [
        name,
        {
          name,
          version,
          integrity: "sha512-AAAA",
          resolved: `https://registry.example/${name}/-/${name}-${version}.tgz`,
        },
      ]),
    ),
    overrides: [],
  };
}

function installed(lockfile: Lockfile): InstallResult {
  return {
    mode: "re-resolve",
    lockfile,
    wroteLockfile: true,
    materialize: {
      directory: "node_modules",
      installed: Object.keys(lockfile.packages),
      skipped: [],
      gate: { packages: [] },
    },
  };
}

interface Recorder {
  intent?: InstallIntent;
  calls: number;
}

function successfulInstall(
  packages: Record<string, string>,
  recorder: Recorder = { calls: 0 },
): InstallSession["install"] {
  return async (intent) => {
    recorder.calls += 1;
    recorder.intent = intent;
    const manifest = (await readRawManifest(intent.directory)) as {
      dependencies?: Record<string, string>;
    };
    const lockfileValue = lockfile(packages, manifest.dependencies ?? {});
    await writeLockfile(intent.directory, lockfileValue);
    return installed(lockfileValue);
  };
}

async function project(dependencies: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-change-"));

  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        dependencies,
        pyloros: { allowScripts: {}, pins: {}, allowAdvisories: [] },
      },
      null,
      2,
    )}\n`,
  );

  return directory;
}

test("add saves an exact tag version and syncs the lockfile root", async () => {
  const directory = await project({});
  const recorder: Recorder = { calls: 0 };

  try {
    const result = await applyDependencyChange(
      directory,
      { kind: "add", spec: "a", saveMode: "exact" },
      {
        registry: registryWithLatest("a", "1.2.3"),
        install: successfulInstall({ a: "1.2.3" }, recorder),
      },
    );

    assert.equal(result.version, "1.2.3");
    assert.equal(result.saved, "1.2.3");
    assert.deepEqual(recorder.intent?.preferred, {});

    const manifest = (await readRawManifest(directory)) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies["a"], "1.2.3");

    const locked = await readLockfile(directory);
    assert.equal(locked?.root.dependencies["a"], "1.2.3");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("add --range saves a caret range", async () => {
  const directory = await project({});

  try {
    const result = await applyDependencyChange(
      directory,
      { kind: "add", spec: "a", saveMode: "caret" },
      {
        registry: registryWithLatest("a", "1.2.3"),
        install: successfulInstall({ a: "1.2.3" }),
      },
    );

    assert.equal(result.saved, "^1.2.3");

    const manifest = (await readRawManifest(directory)) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies["a"], "^1.2.3");
    assert.equal(
      (await readLockfile(directory))?.root.dependencies["a"],
      "^1.2.3",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("add restores the manifest when install fails", async () => {
  const directory = await project({});
  const before = await readFile(join(directory, "package.json"), "utf8");

  try {
    await assert.rejects(
      applyDependencyChange(
        directory,
        { kind: "add", spec: "a", saveMode: "exact" },
        {
          registry: registryWithLatest("a", "1.2.3"),
          install: async () => {
            throw new Error("install failed");
          },
        },
      ),
      /install failed/u,
    );

    assert.equal(
      await readFile(join(directory, "package.json"), "utf8"),
      before,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove deletes the dependency and re-resolves", async () => {
  const directory = await project({ a: "1.0.0" });
  await writeLockfile(directory, lockfile({ a: "1.0.0" }, { a: "1.0.0" }));

  try {
    const result = await applyDependencyChange(
      directory,
      { kind: "remove", name: "a" },
      { install: successfulInstall({}) },
    );

    assert.equal(result.previous, "1.0.0");
    const manifest = (await readRawManifest(directory)) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies["a"], undefined);
    assert.deepEqual((await readLockfile(directory))?.packages, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove restores the manifest when install fails", async () => {
  const directory = await project({ a: "1.0.0" });
  await writeLockfile(directory, lockfile({ a: "1.0.0" }, { a: "1.0.0" }));
  const before = await readFile(join(directory, "package.json"), "utf8");

  try {
    await assert.rejects(
      applyDependencyChange(
        directory,
        { kind: "remove", name: "a" },
        {
          install: async () => {
            throw new Error("install failed");
          },
        },
      ),
      /install failed/u,
    );

    assert.equal(
      await readFile(join(directory, "package.json"), "utf8"),
      before,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update records version changes", async () => {
  const directory = await project({ a: "1.0.0" });
  await writeLockfile(directory, lockfile({ a: "1.0.0" }, { a: "1.0.0" }));

  try {
    const result = await applyDependencyChange(
      directory,
      { kind: "update" },
      { install: successfulInstall({ a: "1.5.0" }) },
    );

    assert.deepEqual(result.changed, [
      { name: "a", from: "1.0.0", to: "1.5.0" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scoped update preserves other Pins", async () => {
  const directory = await project({ a: "1.0.0", b: "1.0.0" });
  await writeLockfile(
    directory,
    lockfile({ a: "1.0.0", b: "1.0.0" }, { a: "1.0.0", b: "1.0.0" }),
  );
  const recorder: Recorder = { calls: 0 };

  try {
    await applyDependencyChange(
      directory,
      { kind: "update", name: "a" },
      { install: successfulInstall({ a: "2.0.0", b: "1.0.0" }, recorder) },
    );

    assert.deepEqual(recorder.intent?.preferred, { b: "1.0.0" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transaction calls the install runner with an explicit intent", async () => {
  const directory = await project({ a: "1.0.0", b: "1.0.0" });
  await writeLockfile(
    directory,
    lockfile({ a: "1.0.0", b: "1.0.0" }, { a: "1.0.0", b: "1.0.0" }),
  );
  const intents: unknown[] = [];

  try {
    await applyDependencyChange(
      directory,
      { kind: "update", name: "a" },
      {
        install: async (intent) => {
          intents.push(intent);
          const manifest = (await readRawManifest(directory)) as {
            dependencies?: Record<string, string>;
          };
          const value = lockfile(
            { a: "2.0.0", b: "1.0.0" },
            manifest.dependencies ?? {},
          );
          await writeLockfile(directory, value);
          return installed(value);
        },
      },
    );

    assert.deepEqual(intents, [
      {
        kind: "re-resolve",
        directory,
        preferred: { b: "1.0.0" },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update rejects a package outside the tree", async () => {
  const directory = await project({ a: "1.0.0" });
  await writeLockfile(directory, lockfile({ a: "1.0.0" }, { a: "1.0.0" }));

  try {
    await assert.rejects(
      applyDependencyChange(
        directory,
        { kind: "update", name: "missing" },
        { install: successfulInstall({ a: "1.0.0" }) },
      ),
      UsageError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update leaves the manifest byte-stable", async () => {
  const directory = await project({ a: "1.0.0" });
  await writeLockfile(directory, lockfile({ a: "1.0.0" }, { a: "1.0.0" }));
  const before = await readFile(join(directory, "package.json"), "utf8");
  const beforeLock = await readFile(
    join(directory, "pyloros-lock.json"),
    "utf8",
  );

  try {
    await applyDependencyChange(
      directory,
      { kind: "update" },
      { install: successfulInstall({ a: "1.0.0" }) },
    );

    assert.equal(
      await readFile(join(directory, "package.json"), "utf8"),
      before,
    );
    assert.equal(
      await readFile(join(directory, "pyloros-lock.json"), "utf8"),
      beforeLock,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
