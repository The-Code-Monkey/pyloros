import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { GateError } from "../src/core/errors.ts";
import { createLockfile } from "../src/core/lockfile.ts";
import { parseProjectManifest } from "../src/core/manifest.ts";
import type { VersionManifest } from "../src/registry/packument.ts";
import { sha512Sri } from "../src/registry/integrity.ts";
import type { Resolution } from "../src/resolve/resolver.ts";
import { ContentStore } from "../src/store/cas.ts";
import { materialize } from "../src/store/materialize.ts";
import type {
  GateReport,
  ProvenanceVerification,
  ProvenanceVerifier,
  SandboxRequest,
  SandboxResult,
  SandboxRunner,
} from "../src/gate/types.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";
import { makeTar } from "./helpers/tar.ts";

const PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" } as const;
const VERIFIED: ProvenanceVerification = {
  status: "verified",
  attestationDigest: "digest",
  subjectIntegrity: "sha512-subject",
  verifiedAt: FIXED_SNAPSHOT,
};

interface Entry {
  name: string;
  version: string;
  manifest: VersionManifest;
  data: Uint8Array;
}

function entry(name: string, files: Record<string, string>): Entry {
  const version = "1.0.0";
  const scripts = Object.fromEntries(
    Object.entries(files).filter(([file]) => file.startsWith("script:")),
  );
  const scriptNames = Object.fromEntries(
    Object.entries(scripts).map(([file, body]) => [file.slice("script:".length), body]),
  );
  const archive = Object.entries(files)
    .filter(([file]) => !file.startsWith("script:"))
    .map(([file, body]) => ({ name: `package/${file}`, data: body }));
  const data = makeTar(archive.length === 0 ? [{ name: "package/", type: "5" }] : archive);

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
      ...(Object.keys(scriptNames).length === 0 ? {} : { scripts: scriptNames }),
    },
  };
}

function lockfile(rootDependencies: Record<string, string>, entries: readonly Entry[]) {
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

  return {
    lockfile: createLockfile(manifest, resolution, { nodeAbi: "137" }),
    tarballs: new Map(entries.map((item) => [item.name, item.data])),
  };
}

class FakeTarballs {
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

class FakeProvenance implements ProvenanceVerifier {
  readonly #result: ProvenanceVerification;

  constructor(result: ProvenanceVerification = VERIFIED) {
    this.#result = result;
  }

  async verify(): Promise<ProvenanceVerification> {
    return this.#result;
  }
}

class FakeSandbox implements SandboxRunner {
  readonly requests: SandboxRequest[] = [];
  readonly #available: boolean;
  readonly #result: SandboxResult;

  constructor(
    available = true,
    result: SandboxResult = { exitCode: 0, signal: null, timedOut: false },
  ) {
    this.#available = available;
    this.#result = result;
  }

  async available(): Promise<boolean> {
    return this.#available;
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    this.requests.push(request);
    return this.#result;
  }
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyloros-gate-"));
}

function policy(allowScripts: Record<string, { reason: string }> = {}) {
  return { allowScripts, pins: {}, allowAdvisories: [] };
}

async function materializeFixture(
  projectDirectory: string,
  rootDependencies: Record<string, string>,
  entries: readonly Entry[],
  options: {
    allowScripts?: Record<string, { reason: string }>;
    provenance?: ProvenanceVerifier;
    sandbox?: SandboxRunner;
  } = {},
) {
  const { lockfile: lock, tarballs } = lockfile(rootDependencies, entries);

  return materialize({
    projectDirectory,
    lockfile: lock,
    registry: new FakeTarballs(tarballs),
    store: new ContentStore(join(projectDirectory, "store")),
    platform: PLATFORM,
    policy: policy(options.allowScripts),
    concurrency: 4,
    now: () => new Date(FIXED_SNAPSHOT),
    ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  });
}

function scripts(report: GateReport, name: string) {
  return report.packages.find((entry) => entry.name === name)?.scripts ?? [];
}

test("blocks lifecycle scripts by default while installing the package", async () => {
  const directory = await project();
  const alpha = entry("alpha", {
    "index.js": "alpha",
    "script:install": "echo should-not-run",
  });

  try {
    const result = await materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
      provenance: new FakeProvenance({ status: "absent" }),
    });

    assert.deepEqual(scripts(result.gate, "alpha"), [
      { name: "install", action: "skipped", reason: "not allowlisted" },
    ]);
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "index.js"), "utf8"),
      "alpha",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs an allowlisted script with verified provenance in the sandbox", async () => {
  const directory = await project();
  const alpha = entry("alpha", {
    "index.js": "alpha",
    "script:preinstall": "echo pre",
    "script:install": "echo install",
  });
  const sandbox = new FakeSandbox();

  try {
    const result = await materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
      allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
      provenance: new FakeProvenance(VERIFIED),
      sandbox,
    });

    assert.deepEqual(scripts(result.gate, "alpha"), [
      { name: "preinstall", action: "executed" },
      { name: "install", action: "executed" },
    ]);
    assert.equal(sandbox.requests.length, 2);
    assert.deepEqual(sandbox.requests[0]?.args, ["-c", "echo pre"]);
    assert.deepEqual(sandbox.requests[1]?.args, ["-c", "echo install"]);
    assert.equal(sandbox.requests[0]?.writable[0]?.target, "/package");
    assert.ok(sandbox.requests[0]?.writable[0]?.source.includes(".pyloros-stage-"));
    assert.equal(sandbox.requests[0]?.readOnly[0]?.target, "/store");
    assert.ok(sandbox.requests[0]?.readOnly[0]?.source.endsWith("store"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an allowlisted script without verified provenance", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "script:install": "echo hi" });

  try {
    await assert.rejects(
      materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
        allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
        provenance: new FakeProvenance({ status: "absent" }),
        sandbox: new FakeSandbox(),
      }),
      GateError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses allowlisted scripts when bubblewrap is unavailable", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "script:install": "echo hi" });

  try {
    await assert.rejects(
      materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
        allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
        provenance: new FakeProvenance(VERIFIED),
        sandbox: new FakeSandbox(false),
      }),
      /bubblewrap is not available/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves the previous tree when a script fails", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "script:install": "exit 1" });

  try {
    await mkdir(join(directory, "node_modules"), { recursive: true });
    await writeFile(join(directory, "node_modules", "marker.txt"), "old");

    await assert.rejects(
      materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
        allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
        provenance: new FakeProvenance(VERIFIED),
        sandbox: new FakeSandbox(true, {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stderr: "boom",
        }),
      }),
      /script failed with exit 1/u,
    );

    assert.equal(
      await readFile(join(directory, "node_modules", "marker.txt"), "utf8"),
      "old",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a source build that is not allowlisted", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "binding.gyp": "{}" });

  try {
    await assert.rejects(
      materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
        provenance: new FakeProvenance({ status: "absent" }),
      }),
      /requires a source build/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an allowlisted source build with no lifecycle script", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "binding.gyp": "{}" });

  try {
    await assert.rejects(
      materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
        allowScripts: { "alpha@1.0.0": { reason: "needs a build" } },
        provenance: new FakeProvenance(VERIFIED),
        sandbox: new FakeSandbox(),
      }),
      /declares no lifecycle script/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows a prebuilt native artifact without scripts", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "binding.node": "binary" });

  try {
    const result = await materializeFixture(directory, { alpha: "1.0.0" }, [alpha], {
      provenance: new FakeProvenance({ status: "absent" }),
    });

    assert.deepEqual(scripts(result.gate, "alpha"), []);
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "binding.node"), "utf8"),
      "binary",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs scripts deterministically by package identity", async () => {
  const directory = await project();
  const alpha = entry("alpha", { "script:install": "echo alpha" });
  const zeta = entry("zeta", { "script:install": "echo zeta" });
  const sandbox = new FakeSandbox();

  try {
    await materializeFixture(directory, { alpha: "1.0.0", zeta: "1.0.0" }, [zeta, alpha], {
      allowScripts: {
        "alpha@1.0.0": { reason: "a" },
        "zeta@1.0.0": { reason: "z" },
      },
      provenance: new FakeProvenance(VERIFIED),
      sandbox,
    });

    assert.deepEqual(
      sandbox.requests.map((request) =>
        basename(request.writable[0]?.source ?? ""),
      ),
      ["alpha", "zeta"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
