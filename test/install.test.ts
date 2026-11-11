import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FrozenDriftError,
  ProvenanceError,
  RuntimeContractError,
} from "../src/core/errors.ts";
import {
  serializeLockfile,
  readLockfile,
  writeLockfile,
} from "../src/core/lockfile.ts";
import { currentNodeAbi, currentNodeVersion } from "../src/core/tool.ts";
import {
  createInstaller,
  type InstallIntent,
  type InstallResult,
  type Registry,
} from "../src/install/installer.ts";
import type { Packument, VersionManifest } from "../src/registry/packument.ts";
import { sha512Sri } from "../src/registry/integrity.ts";
import type { ProvenanceVerifier, SandboxRunner } from "../src/gate/types.ts";
import { ContentStore } from "../src/store/cas.ts";
import { currentPlatform } from "../src/store/platform.ts";
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
  body: string,
  scripts: Record<string, string> = {},
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
        tarball: `https://registry.example/${name}/-/${name}-${version}.tgz`,
        integrity: sha512Sri(data),
      },
      ...(Object.keys(scripts).length === 0 ? {} : { scripts }),
    },
  };
}

class FakeRegistry implements Registry {
  readonly #entries: Map<string, Entry>;

  constructor(entries: readonly Entry[]) {
    this.#entries = new Map(entries.map((item) => [item.name, item]));
  }

  async getPackument(name: string): Promise<Packument> {
    const item = this.#entries.get(name);

    if (item === undefined) {
      throw new Error(`no package ${name}`);
    }

    return {
      name,
      versions: { [item.version]: item.manifest },
      "dist-tags": { latest: item.version },
    };
  }

  async getTarball(manifest: VersionManifest): Promise<Uint8Array> {
    const item = this.#entries.get(manifest.name);

    if (item === undefined) {
      throw new Error(`no tarball for ${manifest.name}`);
    }

    return item.data;
  }
}

class FakeProvenance implements ProvenanceVerifier {
  readonly #digest: string | undefined;
  readonly #status: "verified" | "absent";

  constructor(status: "verified" | "absent", digest = "digest") {
    this.#status = status;
    this.#digest = digest;
  }

  async verify() {
    return this.#status === "verified"
      ? {
          status: "verified" as const,
          attestationDigest: this.#digest,
          subjectIntegrity: "sha512-subject",
          verifiedAt: FIXED_SNAPSHOT,
        }
      : { status: "absent" as const };
  }
}

class FakeSandbox implements SandboxRunner {
  readonly #code: number;

  constructor(code = 0) {
    this.#code = code;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async run() {
    return { exitCode: this.#code, signal: null, timedOut: false };
  }
}

async function project(dependencies: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-install-"));
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

function options(
  directory: string,
  entries: readonly Entry[],
  extra: {
    provenance?: ProvenanceVerifier;
    sandbox?: SandboxRunner;
    reResolve?: boolean;
  } = {},
) {
  return {
    directory,
    registry: new FakeRegistry(entries),
    advisoryProvider: new FakeAdvisories(),
    provenance: extra.provenance ?? new FakeProvenance("absent"),
    sandbox: extra.sandbox ?? new FakeSandbox(),
    now: () => new Date(FIXED_SNAPSHOT),
    ...(extra.reResolve === undefined ? {} : { reResolve: extra.reResolve }),
  };
}

async function runInstall(
  settings: ReturnType<typeof options>,
): Promise<InstallResult> {
  const installer = createInstaller({
    registry: settings.registry,
    advisoryProvider: settings.advisoryProvider,
    provenance: settings.provenance,
    sandbox: settings.sandbox,
    store: new ContentStore(join(settings.directory, "store")),
    platform: currentPlatform(),
    clock: settings.now,
    concurrency: 8,
    allowAdvisories: false,
    nodeVersion: currentNodeVersion(),
    nodeAbi: currentNodeAbi(),
  });
  const existing = await readLockfile(settings.directory);
  const intent: InstallIntent =
    existing === undefined
      ? { kind: "resolve", directory: settings.directory }
      : settings.reResolve === true
        ? { kind: "re-resolve", directory: settings.directory }
        : { kind: "frozen", directory: settings.directory };

  return installer.install(intent);
}

test("resolves, writes the lockfile, and materializes", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha");

  try {
    const result = await runInstall(
      options(directory, [alpha], { provenance: new FakeProvenance("verified") }),
    );

    assert.equal(result.mode, "resolve");
    assert.equal(result.wroteLockfile, true);
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "index.js"), "utf8"),
      "alpha",
    );

    const lockfile = await readLockfile(directory);
    assert.ok(lockfile);
    assert.equal(lockfile.packages["alpha"]?.provenance?.status, "verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second install is frozen and leaves the lockfile untouched", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha");

  try {
    await runInstall(options(directory, [alpha]));
    const before = serializeLockfile((await readLockfile(directory))!);
    const result = await runInstall(options(directory, [alpha]));

    assert.equal(result.mode, "frozen");
    assert.equal(result.wroteLockfile, false);
    assert.equal(serializeLockfile((await readLockfile(directory))!), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a lockfile resolved for another Node version", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha");

  try {
    await runInstall(options(directory, [alpha]));
    const lockfile = (await readLockfile(directory))!;
    lockfile.node = { version: "0.0.0", abi: lockfile.node.abi };
    await writeLockfile(directory, lockfile);

    await assert.rejects(
      runInstall(options(directory, [alpha])),
      RuntimeContractError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects root drift on a frozen install", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha");

  try {
    await runInstall(options(directory, [alpha]));
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          dependencies: { alpha: "^1.0.0" },
          pyloros: { allowScripts: {}, pins: {}, allowAdvisories: [] },
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(
      runInstall(options(directory, [alpha])),
      FrozenDriftError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-resolves when asked", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha");

  try {
    await runInstall(options(directory, [alpha]));
    const result = await runInstall(
      options(directory, [alpha], { reResolve: true }),
    );

    assert.equal(result.mode, "re-resolve");
    assert.equal(result.wroteLockfile, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not persist Gate records when a script fails", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha", { install: "exit 1" });

  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          dependencies: { alpha: "1.0.0" },
          pyloros: {
            allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
            pins: {},
            allowAdvisories: [],
          },
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(
      runInstall(
        options(directory, [alpha], {
          provenance: new FakeProvenance("verified"),
          sandbox: new FakeSandbox(1),
        }),
      ),
      /script failed/u,
    );
    assert.equal(await readLockfile(directory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails a frozen install when the attestation digest changed", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha", { install: "echo hi" });

  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          dependencies: { alpha: "1.0.0" },
          pyloros: {
            allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
            pins: {},
            allowAdvisories: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    await runInstall(
      options(directory, [alpha], {
        provenance: new FakeProvenance("verified", "old-digest"),
        sandbox: new FakeSandbox(0),
      }),
    );

    await assert.rejects(
      runInstall(
        options(directory, [alpha], {
          provenance: new FakeProvenance("verified", "new-digest"),
          sandbox: new FakeSandbox(0),
        }),
      ),
      ProvenanceError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
