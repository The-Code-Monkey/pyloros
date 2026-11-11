import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLockfile, serializeLockfile } from "../src/core/lockfile.ts";
import type { ProvenanceVerifier, SandboxRunner } from "../src/gate/types.ts";
import {
  createInstaller,
  type InstallerEnvironment,
  type Registry,
} from "../src/install/installer.ts";
import { sha512Hex, sha512Sri } from "../src/registry/integrity.ts";
import type { Packument, VersionManifest } from "../src/registry/packument.ts";
import { ContentStore } from "../src/store/cas.ts";
import type { Platform } from "../src/store/platform.ts";
import { FIXED_SNAPSHOT, FakeAdvisories } from "./helpers/advisories.ts";
import { makeTar } from "./helpers/tar.ts";

interface Entry {
  name: string;
  version: string;
  manifest: VersionManifest;
  data: Uint8Array;
}

function entry(
  name: string,
  version: string,
  body: string,
  extra: Partial<VersionManifest> = {},
): Entry {
  const data = makeTar([{ name: "package/index.js", data: body }]);

  return {
    name,
    version,
    data,
    manifest: {
      name,
      version,
      engines: { node: ">=18" },
      dist: {
        tarball: `https://registry.example/${name}/-/${name}-${version}.tgz`,
        integrity: sha512Sri(data),
      },
      ...extra,
    },
  };
}

class FakeRegistry implements Registry {
  readonly #entries: Map<string, Entry>;
  readonly #delayMs: number;
  active = 0;
  maxActive = 0;

  constructor(entries: readonly Entry[], delayMs = 0) {
    this.#entries = new Map(
      entries.map((item) => [`${item.name}@${item.version}`, item]),
    );
    this.#delayMs = delayMs;
  }

  async getPackument(name: string): Promise<Packument> {
    const versions: Record<string, VersionManifest> = {};

    for (const item of this.#entries.values()) {
      if (item.name === name) {
        versions[item.version] = item.manifest;
      }
    }

    if (Object.keys(versions).length === 0) {
      throw new Error(`no package ${name}`);
    }

    const latest = Object.keys(versions).sort().at(-1) as string;

    return { name, versions, "dist-tags": { latest } };
  }

  async getTarball(manifest: VersionManifest): Promise<Uint8Array> {
    const item = this.#entries.get(`${manifest.name}@${manifest.version}`);

    if (item === undefined) {
      throw new Error(`no tarball for ${manifest.name}@${manifest.version}`);
    }

    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      if (this.#delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
      }

      return item.data;
    } finally {
      this.active -= 1;
    }
  }
}

class FakeProvenance implements ProvenanceVerifier {
  async verify() {
    return {
      status: "verified" as const,
      attestationDigest: "digest",
      subjectIntegrity: "sha512-subject",
      verifiedAt: FIXED_SNAPSHOT,
    };
  }
}

class FakeSandbox implements SandboxRunner {
  async available(): Promise<boolean> {
    return true;
  }

  async run() {
    return { exitCode: 0, signal: null, timedOut: false };
  }
}

const PLATFORM: Platform = { os: "linux", cpu: "x64", libc: "glibc" };
const NODE_VERSION = "24.14.1";
const NODE_ABI = "137";

async function project(manifest: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  allowScripts?: Record<string, { reason: string }>;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-installer-"));

  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        dependencies: manifest.dependencies,
        optionalDependencies: manifest.optionalDependencies,
        pyloros: {
          allowScripts: manifest.allowScripts ?? {},
          pins: {},
          allowAdvisories: [],
        },
      },
      null,
      2,
    )}\n`,
  );

  return directory;
}

function environment(
  directory: string,
  registry: Registry,
  extra: Partial<InstallerEnvironment> = {},
): InstallerEnvironment {
  return {
    registry,
    advisoryProvider: new FakeAdvisories(),
    provenance: new FakeProvenance(),
    sandbox: new FakeSandbox(),
    store: new ContentStore(join(directory, "store")),
    platform: PLATFORM,
    clock: () => new Date(FIXED_SNAPSHOT),
    concurrency: 8,
    allowAdvisories: false,
    nodeVersion: NODE_VERSION,
    nodeAbi: NODE_ABI,
    ...extra,
  };
}

test("installer resolves and materializes from an explicit environment", async () => {
  const directory = await project({ dependencies: { alpha: "1.0.0" } });
  const registry = new FakeRegistry([entry("alpha", "1.0.0", "alpha")]);

  try {
    const installer = createInstaller(environment(directory, registry));
    const result = await installer.install({ kind: "resolve", directory });

    assert.equal(result.mode, "resolve");
    assert.equal(result.wroteLockfile, true);
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "index.js"), "utf8"),
      "alpha",
    );

    const lockfile = await readLockfile(directory);
    assert.ok(lockfile);
    assert.equal(lockfile.node.version, NODE_VERSION);
    assert.equal(lockfile.node.abi, NODE_ABI);
    assert.equal(lockfile.packages["alpha"]?.provenance?.status, "verified");

    const state = JSON.parse(
      await readFile(
        join(directory, "node_modules", ".pyloros", "state.json"),
        "utf8",
      ),
    ) as { installedAt: string };
    assert.equal(state.installedAt, FIXED_SNAPSHOT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer persists Gate records and provenance after success", async () => {
  const directory = await project({
    dependencies: { alpha: "1.0.0" },
    allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
  });
  const registry = new FakeRegistry([
    entry("alpha", "1.0.0", "alpha", { scripts: { install: "echo hi" } }),
  ]);

  try {
    const installer = createInstaller(environment(directory, registry));
    const result = await installer.install({ kind: "resolve", directory });

    assert.deepEqual(result.materialize.gate.packages[0]?.scripts, [
      { name: "install", action: "executed" },
    ]);

    const lockfile = await readLockfile(directory);
    assert.ok(lockfile);
    assert.equal(lockfile.packages["alpha"]?.provenance?.status, "verified");
    assert.deepEqual(lockfile.packages["alpha"]?.gate, {
      allowedScripts: ["install"],
      reason: "needs a build",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("frozen intent reuses the lockfile without rewriting it", async () => {
  const directory = await project({ dependencies: { alpha: "1.0.0" } });
  const registry = new FakeRegistry([entry("alpha", "1.0.0", "alpha")]);

  try {
    const installer = createInstaller(environment(directory, registry));
    await installer.install({ kind: "resolve", directory });
    const before = serializeLockfile((await readLockfile(directory))!);
    const result = await installer.install({ kind: "frozen", directory });

    assert.equal(result.mode, "frozen");
    assert.equal(result.wroteLockfile, false);
    assert.equal(serializeLockfile((await readLockfile(directory))!), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-resolve intent takes preferred versions from the intent", async () => {
  const directory = await project({ dependencies: { alpha: "*" } });
  const registry = new FakeRegistry([
    entry("alpha", "1.0.0", "one"),
    entry("alpha", "2.0.0", "two"),
  ]);

  try {
    const installer = createInstaller(environment(directory, registry));
    const first = await installer.install({ kind: "resolve", directory });
    assert.equal(first.lockfile.packages["alpha"]?.version, "2.0.0");

    const second = await installer.install({
      kind: "re-resolve",
      directory,
      preferred: { alpha: "1.0.0" },
    });

    assert.equal(second.mode, "re-resolve");
    assert.equal(second.wroteLockfile, true);
    assert.equal(second.lockfile.packages["alpha"]?.version, "1.0.0");
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "index.js"), "utf8"),
      "one",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer filters platform variants with the injected platform", async () => {
  const directory = await project({
    optionalDependencies: {
      alpha: "1.0.0",
      beta: "1.0.0",
      gamma: "1.0.0",
    },
  });
  const registry = new FakeRegistry([
    entry("alpha", "1.0.0", "alpha", { os: ["linux"], cpu: ["x64"] }),
    entry("beta", "1.0.0", "beta", { os: ["darwin"], cpu: ["arm64"] }),
    entry("gamma", "1.0.0", "gamma", { os: ["darwin"], cpu: ["x64"] }),
  ]);

  try {
    const installer = createInstaller(
      environment(directory, registry, {
        platform: { os: "darwin", cpu: "arm64" },
      }),
    );
    const result = await installer.install({ kind: "resolve", directory });

    assert.deepEqual(result.materialize.installed, ["beta"]);
    assert.deepEqual(result.materialize.skipped, ["alpha", "gamma"]);
    await assert.rejects(
      stat(join(directory, "node_modules", "alpha")),
      /ENOENT/u,
    );
    await assert.rejects(
      stat(join(directory, "node_modules", "gamma")),
      /ENOENT/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer reuses the injected Store across installs", async () => {
  const directory = await project({ dependencies: { alpha: "1.0.0" } });
  const alpha = entry("alpha", "1.0.0", "alpha");
  const registry = new FakeRegistry([alpha]);
  const store = new ContentStore(join(directory, "store"));

  try {
    const installer = createInstaller(environment(directory, registry, { store }));
    await installer.install({ kind: "resolve", directory });

    const cached = join(
      store.root,
      "packages",
      sha512Hex(alpha.data),
      "package",
      "index.js",
    );
    assert.equal(await readFile(cached, "utf8"), "alpha");

    await rm(join(directory, "node_modules"), { recursive: true, force: true });
    await writeFile(cached, "cached");

    const result = await installer.install({ kind: "frozen", directory });

    assert.equal(result.mode, "frozen");
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "index.js"), "utf8"),
      "cached",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer honours the configured concurrency limit", async () => {
  const directory = await project({
    dependencies: { alpha: "1.0.0", beta: "1.0.0" },
  });
  const registry = new FakeRegistry(
    [entry("alpha", "1.0.0", "alpha"), entry("beta", "1.0.0", "beta")],
    10,
  );

  try {
    const installer = createInstaller(
      environment(directory, registry, { concurrency: 1 }),
    );
    const result = await installer.install({ kind: "resolve", directory });

    assert.deepEqual(result.materialize.installed, ["alpha", "beta"]);
    assert.equal(registry.maxActive, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
