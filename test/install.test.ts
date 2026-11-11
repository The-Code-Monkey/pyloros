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
import {
  createInstallSession,
  type InstallIntent,
  type InstallResult,
} from "../src/install/install-session.ts";
import type { VersionManifest } from "../src/registry/packument.ts";
import { sha512Sri } from "../src/registry/integrity.ts";
import type { ProvenanceVerifier, SandboxRunner } from "../src/gate/types.ts";
import { ContentStore } from "../src/store/cas.ts";
import { FIXED_SNAPSHOT, FakeAdvisories } from "./helpers/advisories.ts";
import {
  ABSENT,
  FakeProvenance,
  FakeRegistry,
  FakeSandbox,
  NODE_ABI,
  NODE_VERSION,
  PLATFORM,
  VERIFIED,
  verified,
  type RegistryEntry,
} from "./helpers/install.ts";
import { makeTar } from "./helpers/tar.ts";

type Entry = RegistryEntry & { data: Uint8Array };

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
    provenance: extra.provenance ?? new FakeProvenance(ABSENT),
    sandbox: extra.sandbox ?? new FakeSandbox(),
    now: () => new Date(FIXED_SNAPSHOT),
    ...(extra.reResolve === undefined ? {} : { reResolve: extra.reResolve }),
  };
}

async function runInstall(
  settings: ReturnType<typeof options>,
): Promise<InstallResult> {
  const session = createInstallSession({
    registry: settings.registry,
    advisoryProvider: settings.advisoryProvider,
    provenance: settings.provenance,
    sandbox: settings.sandbox,
    store: new ContentStore(join(settings.directory, "store")),
    platform: PLATFORM,
    clock: settings.now,
    concurrency: 4,
    scriptTimeoutMs: 30_000,
    allowAdvisories: false,
    nodeVersion: NODE_VERSION,
    nodeAbi: NODE_ABI,
  });
  const existing = await readLockfile(settings.directory);
  const intent: InstallIntent =
    existing === undefined
      ? { kind: "resolve", directory: settings.directory }
      : settings.reResolve === true
        ? { kind: "re-resolve", directory: settings.directory }
        : { kind: "frozen", directory: settings.directory };

  return session.install(intent);
}

test("resolves, writes the lockfile, and materializes", async () => {
  const directory = await project({ alpha: "1.0.0" });
  const alpha = entry("alpha", "alpha");

  try {
    const result = await runInstall(
      options(directory, [alpha], { provenance: new FakeProvenance(VERIFIED) }),
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
          provenance: new FakeProvenance(VERIFIED),
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
        provenance: new FakeProvenance(verified("old-digest")),
        sandbox: new FakeSandbox(0),
      }),
    );

    await assert.rejects(
      runInstall(
        options(directory, [alpha], {
          provenance: new FakeProvenance(verified("new-digest")),
          sandbox: new FakeSandbox(0),
        }),
      ),
      ProvenanceError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
