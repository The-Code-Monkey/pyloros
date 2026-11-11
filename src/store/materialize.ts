import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { PlatformError } from "../core/errors.ts";
import type {
  Lockfile,
  LockfilePackage,
  LockfileProvenance,
} from "../core/lockfile.ts";
import type { PylorosPolicy } from "../core/manifest.ts";
import type { VersionManifest } from "../registry/packument.ts";
import { runGate } from "../gate/gate.ts";
import type {
  GateReport,
  ProvenanceVerifier,
  SandboxRunner,
} from "../gate/types.ts";
import type { ContentStore } from "./cas.ts";
import { matchesPlatform, type Platform } from "./platform.ts";

export interface TarballSource {
  getTarball(manifest: VersionManifest): Promise<Uint8Array>;
}

export interface MaterializeOptions {
  projectDirectory: string;
  lockfile: Lockfile;
  registry: TarballSource;
  store: ContentStore;
  platform: Platform;
  concurrency: number;
  now: () => Date;
  policy: PylorosPolicy;
  provenance?: ProvenanceVerifier;
  sandbox?: SandboxRunner;
  expectedProvenance?: ReadonlyMap<string, LockfileProvenance>;
  scriptTimeoutMs?: number;
}

export interface MaterializeResult {
  directory: string;
  installed: string[];
  skipped: string[];
  gate: GateReport;
}

const LINK_FALLBACK_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "EMLINK",
  "ENOSYS",
  "EOPNOTSUPP",
]);

const STATE_DIRECTORY = ".pyloros";
const STAGE_PREFIX = ".pyloros-stage-";
const PREVIOUS_PREFIX = ".pyloros-previous-";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function manifestFromLock(pkg: LockfilePackage): VersionManifest {
  return {
    name: pkg.name,
    version: pkg.version,
    dist: { tarball: pkg.resolved, integrity: pkg.integrity },
    ...(pkg.engines === undefined ? {} : { engines: pkg.engines }),
    ...(pkg.os === undefined ? {} : { os: pkg.os }),
    ...(pkg.cpu === undefined ? {} : { cpu: pkg.cpu }),
    ...(pkg.libc === undefined ? {} : { libc: pkg.libc }),
    ...(pkg.peerDependencies === undefined
      ? {}
      : { peerDependencies: pkg.peerDependencies }),
    ...(pkg.deprecated === undefined ? {} : { deprecated: pkg.deprecated }),
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const count = Math.max(1, Math.min(limit, items.length));

  const run = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: count }, run));
  return results;
}

async function linkFile(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === undefined || !LINK_FALLBACK_CODES.has(code)) {
      throw error;
    }
  }

  await copyFile(source, target, constants.COPYFILE_FICLONE);
  await chmod(target, (await stat(source)).mode & 0o777);
}

async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o755 });

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);

    if (entry.isDirectory()) {
      await copyTree(from, to);
      continue;
    }

    if (entry.isFile()) {
      await linkFile(from, to);
      continue;
    }

    throw new Error(`refusing to materialize non-regular file: ${from}`);
  }
}

async function packageRoot(directory: string): Promise<string> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => !entry.name.startsWith("."),
  );

  if (entries.length === 1 && entries[0]?.isDirectory() === true) {
    return join(directory, entries[0].name);
  }

  return directory;
}

async function swapIntoPlace(
  projectDirectory: string,
  staging: string,
): Promise<void> {
  const target = join(projectDirectory, "node_modules");
  const previous = join(
    projectDirectory,
    `${PREVIOUS_PREFIX}${process.pid}-${randomUUID()}`,
  );
  let moved = false;

  try {
    if (await exists(target)) {
      await rename(target, previous);
      moved = true;
    }

    await rename(staging, target);
  } catch (error) {
    if (moved) {
      await rename(previous, target).catch(() => undefined);
    }

    throw error;
  }

  if (moved) {
    await rm(previous, { recursive: true, force: true });
  }
}

async function restoreNewestPrevious(projectDirectory: string): Promise<void> {
  if (await exists(join(projectDirectory, "node_modules"))) {
    return;
  }

  const candidates = (await readdir(projectDirectory))
    .filter((name) => name.startsWith(PREVIOUS_PREFIX))
    .map((name) => join(projectDirectory, name));

  if (candidates.length === 0) {
    return;
  }

  const ranked: { path: string; modified: number }[] = [];

  for (const path of candidates) {
    try {
      ranked.push({ path, modified: (await stat(path)).mtimeMs });
    } catch {
      continue;
    }
  }

  ranked.sort((left, right) => right.modified - left.modified);
  const newest = ranked[0];

  if (newest !== undefined) {
    await rename(newest.path, join(projectDirectory, "node_modules"));
  }
}

export async function recoverInterrupted(projectDirectory: string): Promise<void> {
  await restoreNewestPrevious(projectDirectory);

  for (const name of await readdir(projectDirectory)) {
    if (name.startsWith(STAGE_PREFIX)) {
      await rm(join(projectDirectory, name), { recursive: true, force: true });
    }
  }
}

export async function materialize(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const platform = options.platform;
  const store = options.store;
  const now = options.now;
  const packages = Object.values(options.lockfile.packages).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const name of Object.keys(options.lockfile.root.dependencies)) {
    const pkg = options.lockfile.packages[name];

    if (pkg !== undefined && !matchesPlatform(pkg, platform)) {
      throw new PlatformError(
        `root dependency ${name}@${pkg.version} does not support ${platform.os}/${platform.cpu}`,
      );
    }
  }

  const selected = packages.filter((pkg) => matchesPlatform(pkg, platform));
  const skipped = packages
    .filter((pkg) => !matchesPlatform(pkg, platform))
    .map((pkg) => pkg.name);

  await recoverInterrupted(options.projectDirectory);

  const staging = join(
    options.projectDirectory,
    `${STAGE_PREFIX}${process.pid}-${randomUUID()}`,
  );

  await mkdir(staging, { recursive: true });

  try {
    const extracted = await mapLimit(
      selected,
      options.concurrency,
      async (pkg) => {
        const data = await options.registry.getTarball(manifestFromLock(pkg));
        const entry = await store.putTarball(data);
        return { pkg, directory: await packageRoot(entry.directory), data };
      },
    );

    const directories = new Map<string, string>();
    const tarballs = new Map<string, Uint8Array>();

    for (const item of extracted) {
      const target = join(staging, ...item.pkg.name.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyTree(item.directory, target);
      directories.set(item.pkg.name, target);
      tarballs.set(item.pkg.name, item.data);
    }

    const gate = await runGate({
      policy: options.policy,
      packages: selected,
      directories,
      tarballs,
      storeRoot: store.root,
      ...(options.provenance === undefined
        ? {}
        : { provenance: options.provenance }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.expectedProvenance === undefined
        ? {}
        : { expectedProvenance: options.expectedProvenance }),
      ...(options.scriptTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.scriptTimeoutMs }),
    });

    const stateDirectory = join(staging, STATE_DIRECTORY);
    await mkdir(stateDirectory, { recursive: true, mode: 0o755 });
    await writeFile(
      join(stateDirectory, "state.json"),
      `${JSON.stringify(
        {
          tool: options.lockfile.tool,
          node: options.lockfile.node,
          installedAt: now().toISOString(),
          packages: selected.map((pkg) => `${pkg.name}@${pkg.version}`),
          skipped,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );

    await swapIntoPlace(options.projectDirectory, staging);

    return {
      directory: join(options.projectDirectory, "node_modules"),
      installed: selected.map((pkg) => pkg.name),
      skipped,
      gate,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
