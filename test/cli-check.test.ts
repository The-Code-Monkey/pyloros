import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Project {
  dependencies?: Record<string, string>;
  nodeVersion?: string;
  packages?: Record<string, unknown>;
  writeLockfile?: boolean;
}

function lockfile(options: Project): string {
  return `${JSON.stringify(
    {
      lockfileVersion: 1,
      tool: "pyloros@0.0.0",
      node: {
        version: options.nodeVersion ?? process.version.replace(/^v/u, ""),
        abi: process.versions.modules ?? "unknown",
      },
      root: {
        dependencies: options.dependencies ?? {},
        optionalDependencies: {},
      },
      advisories: {
        snapshotAt: "2026-01-01T00:00:00.000Z",
        sources: [],
        entries: {},
      },
      packages: options.packages ?? {},
      overrides: [],
    },
    null,
    2,
  )}\n`;
}

async function project(options: Project = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-cli-"));
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "cli-fixture",
        version: "1.0.0",
        dependencies: options.dependencies ?? {},
      },
      null,
      2,
    )}\n`,
  );

  if (options.writeLockfile !== false) {
    await writeFile(join(directory, "pyloros-lock.json"), lockfile(options));
  }

  return directory;
}

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [cli, "check"], { cwd, encoding: "utf8" });
}

test("check exits 0 for a consistent lockfile", async () => {
  const directory = await project();

  try {
    const result = runCheck(directory);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /lockfile is consistent/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("check exits 7 when package.json drifts from the lockfile", async () => {
  const directory = await project();

  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        { name: "cli-fixture", version: "1.0.0", dependencies: { a: "1.0.0" } },
        null,
        2,
      )}\n`,
    );

    const result = runCheck(directory);
    assert.equal(result.status, 7);
    assert.match(result.stderr, /differ from the lockfile/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("check exits 4 when the lockfile was resolved for another Node", async () => {
  const directory = await project({ nodeVersion: "0.0.0" });

  try {
    const result = runCheck(directory);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /resolved for Node 0\.0\.0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("check exits 6 when the lockfile is missing", async () => {
  const directory = await project({ writeLockfile: false });

  try {
    const result = runCheck(directory);
    assert.equal(result.status, 6);
    assert.match(result.stderr, /no pyloros-lock\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
