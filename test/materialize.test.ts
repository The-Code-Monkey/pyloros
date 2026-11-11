import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PlatformError } from "../src/core/errors.ts";
import { createLockfile } from "../src/core/lockfile.ts";
import { parseProjectManifest } from "../src/core/manifest.ts";
import { sha512Sri } from "../src/registry/integrity.ts";
import type { VersionManifest } from "../src/registry/packument.ts";
import type { Resolution } from "../src/resolve/resolver.ts";
import { ContentStore } from "../src/store/cas.ts";
import {
  materialize,
  recoverInterrupted,
  type TarballSource,
} from "../src/store/materialize.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import { makeTar } from "./helpers/tar.ts";

const PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" } as const;
const POLICY = { allowScripts: {}, pins: {}, allowAdvisories: [] };
const NOW = () => new Date(FIXED_SNAPSHOT);
const CONCURRENCY = 4;

interface Entry {
  name: string;
  version: string;
  manifest: VersionManifest;
  data: Uint8Array;
}

function entry(
  name: string,
  body: string,
  extra: Partial<VersionManifest> = {},
): Entry {
  const version = "1.0.0";
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
        tarball: `https://registry.example/${name}/-/${name}-1.0.0.tgz`,
        integrity: sha512Sri(data),
      },
      ...extra,
    },
  };
}

function setup(rootDependencies: Record<string, string>, entries: readonly Entry[]) {
  const resolution: Resolution = {
    nodeVersion: "24.14.1",
    packages: entries.map((item) => ({
      name: item.name,
      version: item.version,
      manifest: item.manifest,
    })),
    advisories: { snapshotAt: FIXED_SNAPSHOT, sources: [], entries: {} },
    overrides: [],
  };
  const manifest = parseProjectManifest("/project", {
    name: "fixture",
    dependencies: rootDependencies,
  });
  const lockfile = createLockfile(manifest, resolution, { nodeAbi: "137" });
  const tarballs = new Map(entries.map((item) => [item.name, item.data]));

  return { lockfile, tarballs };
}

class FakeTarballs implements TarballSource {
  readonly #tarballs: Map<string, Uint8Array>;

  constructor(tarballs: Map<string, Uint8Array>) {
    this.#tarballs = tarballs;
  }

  async getTarball(manifest: VersionManifest): Promise<Uint8Array> {
    const data = this.#tarballs.get(manifest.name);

    if (data === undefined) {
      throw new Error(`no tarball for ${manifest.name}`);
    }

    return data;
  }
}

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyloros-materialize-"));
}

test("materializes a flat tree and skips mismatched platform variants", async () => {
  const project = await tempProject();
  const alpha = entry("alpha", "alpha", { os: ["linux"], cpu: ["x64"] });
  const beta = entry("beta", "beta", { os: ["darwin"] });
  const gamma = entry("@scope/gamma", "gamma");
  const musl = entry("musl-only", "musl", { libc: ["musl"] });
  const { lockfile, tarballs } = setup(
    { alpha: "1.0.0", "@scope/gamma": "1.0.0" },
    [alpha, beta, gamma, musl],
  );

  try {
    const result = await materialize({
      projectDirectory: project,
      lockfile,
      registry: new FakeTarballs(tarballs),
      store: new ContentStore(join(project, "store")),
      platform: PLATFORM,
      policy: POLICY,
      concurrency: CONCURRENCY,
      now: NOW,
    });

    assert.deepEqual(result.installed, ["@scope/gamma", "alpha"]);
    assert.deepEqual(result.skipped, ["beta", "musl-only"]);

    const root = join(project, "node_modules");
    assert.equal(await readFile(join(root, "alpha", "index.js"), "utf8"), "alpha");
    assert.equal(
      await readFile(join(root, "@scope", "gamma", "index.js"), "utf8"),
      "gamma",
    );
    await assert.rejects(readFile(join(root, "beta", "index.js")), /ENOENT/);

    const state = JSON.parse(
      await readFile(join(root, ".pyloros", "state.json"), "utf8"),
    ) as { packages: string[]; skipped: string[]; installedAt: string };
    assert.deepEqual(state.packages, ["@scope/gamma@1.0.0", "alpha@1.0.0"]);
    assert.deepEqual(state.skipped, ["beta", "musl-only"]);
    assert.equal(state.installedAt, FIXED_SNAPSHOT);

    const leftovers = (await readdir(project)).filter((name) =>
      name.startsWith(".pyloros-"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("rejects a root dependency that does not support the platform", async () => {
  const project = await tempProject();
  const beta = entry("beta", "beta", { os: ["darwin"] });
  const { lockfile, tarballs } = setup({ beta: "1.0.0" }, [beta]);

  try {
    await assert.rejects(
      materialize({
        projectDirectory: project,
        lockfile,
        registry: new FakeTarballs(tarballs),
        store: new ContentStore(join(project, "store")),
        platform: PLATFORM,
        policy: POLICY,
        concurrency: CONCURRENCY,
        now: NOW,
      }),
      PlatformError,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("keeps the previous tree when materialization fails", async () => {
  const project = await tempProject();
  const alpha = entry("alpha", "alpha");
  const { lockfile, tarballs } = setup({ alpha: "1.0.0" }, [alpha]);

  try {
    await mkdir(join(project, "node_modules"), { recursive: true });
    await writeFile(join(project, "node_modules", "marker.txt"), "old");

    const broken = new FakeTarballs(new Map());
    broken.getTarball = async () => {
      throw new Error("network down");
    };

    await assert.rejects(
      materialize({
        projectDirectory: project,
        lockfile,
        registry: broken,
        store: new ContentStore(join(project, "store")),
        platform: PLATFORM,
        policy: POLICY,
        concurrency: CONCURRENCY,
        now: NOW,
      }),
      /network down/,
    );

    assert.equal(
      await readFile(join(project, "node_modules", "marker.txt"), "utf8"),
      "old",
    );

    const leftovers = (await readdir(project)).filter((name) =>
      name.startsWith(".pyloros-"),
    );
    assert.deepEqual(leftovers, []);
    assert.equal(tarballs.size, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("restores an interrupted swap and clears stale staging", async () => {
  const project = await tempProject();

  try {
    await mkdir(join(project, ".pyloros-previous-1-abc"), { recursive: true });
    await writeFile(
      join(project, ".pyloros-previous-1-abc", "old.txt"),
      "previous",
    );
    await mkdir(join(project, ".pyloros-stage-1-abc"), { recursive: true });
    await writeFile(join(project, ".pyloros-stage-1-abc", "junk.txt"), "junk");

    await recoverInterrupted(project);

    assert.equal(
      await readFile(join(project, "node_modules", "old.txt"), "utf8"),
      "previous",
    );
    const names = await readdir(project);
    assert.equal(names.some((name) => name.startsWith(".pyloros-stage-")), false);
    assert.equal(names.some((name) => name.startsWith(".pyloros-previous-")), false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
