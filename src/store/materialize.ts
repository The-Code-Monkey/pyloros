import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
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
  provenance: ProvenanceVerifier;
  sandbox: SandboxRunner;
  expectedProvenance?: ReadonlyMap<string, LockfileProvenance>;
  scriptTimeoutMs: number;
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

export async function materialize(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const packages = Object.values(options.lockfile.packages).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const name of Object.keys(options.lockfile.root.dependencies)) {
    const pkg = options.lockfile.packages[name];

    if (pkg !== undefined && !matchesPlatform(pkg, options.platform)) {
      throw new PlatformError(
        `root dependency ${name}@${pkg.version} does not support ${options.platform.os}/${options.platform.cpu}`,
      );
    }
  }

  const selected = packages.filter((pkg) => matchesPlatform(pkg, options.platform));
  const skipped = packages
    .filter((pkg) => !matchesPlatform(pkg, options.platform))
    .map((pkg) => pkg.name);

  const tree = await openTree(options.projectDirectory);
  const staging = tree.staging;

  try {
    const extracted = await mapLimit(
      selected,
      options.concurrency,
      async (pkg) => {
        const data = await options.registry.getTarball(manifestFromLock(pkg));
        const entry = await options.store.putTarball(data);
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
      storeRoot: options.store.root,
      provenance: options.provenance,
      sandbox: options.sandbox,
      ...(options.expectedProvenance === undefined
        ? {}
        : { expectedProvenance: options.expectedProvenance }),
      timeoutMs: options.scriptTimeoutMs,
    });

    const stateDirectory = join(staging, STATE_DIRECTORY);
    await mkdir(stateDirectory, { recursive: true, mode: 0o755 });
    await writeFile(
      join(stateDirectory, "state.json"),
      `${JSON.stringify(
        {
          tool: options.lockfile.tool,
          node: options.lockfile.node,
          installedAt: options.now().toISOString(),
          packages: selected.map((pkg) => `${pkg.name}@${pkg.version}`),
          skipped,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );

    await tree.commit();

    return {
      directory: join(options.projectDirectory, "node_modules"),
      installed: selected.map((pkg) => pkg.name),
      skipped,
      gate,
    };
  } catch (error) {
    await tree.abort();
    throw error;
  }
}
