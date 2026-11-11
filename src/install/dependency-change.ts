import semver from "../core/semver.ts";
import { LockfileError, UsageError } from "../core/errors.ts";
import {
  readLockfile,
  writeLockfile,
  type Lockfile,
} from "../core/lockfile.ts";
import { parseProjectManifest } from "../core/manifest.ts";
import type {
  InstallIntent,
  InstallResult,
  Registry,
} from "./installer.ts";
import {
  readRawManifest,
  removeDependency,
  setDependency,
  writeRawManifest,
} from "./manifest-edit.ts";
import { parsePackageSpec } from "./package-spec.ts";

export type SaveMode = "exact" | "caret";

export type DependencyChange =
  | { kind: "add"; spec: string; saveMode: SaveMode }
  | { kind: "remove"; name: string }
  | { kind: "update"; name?: string };

export type InstallRunner = (intent: InstallIntent) => Promise<InstallResult>;

export interface DependencyChangeOptions {
  registry?: Registry;
  install: InstallRunner;
}

export interface DependencyChangeDiff {
  name: string;
  from: string | null;
  to: string | null;
}

export interface DependencyChangeResult {
  kind: DependencyChange["kind"];
  name: string | null;
  version: string | null;
  saved: string | null;
  previous: string | null;
  changed: DependencyChangeDiff[];
  lockfile: Lockfile;
  install: InstallResult;
}

function changes(before: Lockfile, after: Lockfile): DependencyChangeDiff[] {
  const names = new Set([
    ...Object.keys(before.packages),
    ...Object.keys(after.packages),
  ]);
  const result: DependencyChangeDiff[] = [];

  for (const name of [...names].sort()) {
    const from = before.packages[name]?.version ?? null;
    const to = after.packages[name]?.version ?? null;

    if (from !== to) {
      result.push({ name, from, to });
    }
  }

  return result;
}

function preferredVersions(
  lockfile: Lockfile | undefined,
  exclude: readonly string[] = [],
): Record<string, string> {
  const preferred: Record<string, string> = {};

  if (lockfile === undefined) {
    return preferred;
  }

  for (const pkg of Object.values(lockfile.packages)) {
    if (!exclude.includes(pkg.name)) {
      preferred[pkg.name] = pkg.version;
    }
  }

  return preferred;
}

function intentFor(
  directory: string,
  existing: Lockfile | undefined,
  preferred?: Readonly<Record<string, string>>,
): InstallIntent {
  if (existing === undefined) {
    return preferred === undefined
      ? { kind: "resolve", directory }
      : { kind: "resolve", directory, preferred };
  }

  return preferred === undefined
    ? { kind: "re-resolve", directory }
    : { kind: "re-resolve", directory, preferred };
}

async function provisionalRange(
  spec: string,
  registry: Registry,
): Promise<{ name: string; range: string }> {
  const parsed = parsePackageSpec(spec);
  const packument = await registry.getPackument(parsed.name);
  const tags = packument["dist-tags"] ?? {};
  let range: string;

  if (parsed.range === undefined) {
    const latest = tags["latest"];

    if (latest === undefined) {
      throw new UsageError(`${parsed.name} has no latest dist-tag`);
    }

    range = latest;
  } else if (semver.validRange(parsed.range) !== null) {
    range = parsed.range;
  } else {
    const tagged = tags[parsed.range];

    if (tagged === undefined) {
      throw new UsageError(
        `${parsed.name} has no dist-tag named ${parsed.range}`,
      );
    }

    range = tagged;
  }

  return { name: parsed.name, range };
}

export async function applyDependencyChange(
  directory: string,
  change: DependencyChange,
  options: DependencyChangeOptions,
): Promise<DependencyChangeResult> {
  const install = options.install;
  const original = await readRawManifest(directory);
  const snapshot = structuredClone(original);
  parseProjectManifest(directory, structuredClone(original));
  const existing = await readLockfile(directory);

  if (change.kind === "add") {
    const registry = options.registry;

    if (registry === undefined) {
      throw new UsageError("add needs a registry");
    }

    const provisional = await provisionalRange(change.spec, registry);
    const preferred = preferredVersions(existing, [provisional.name]);

    setDependency(original, provisional.name, provisional.range);
    await writeRawManifest(directory, original);

    try {
      const result = await install(
        intentFor(directory, existing, preferred),
      );
      const chosen = result.lockfile.packages[provisional.name];

      if (chosen === undefined) {
        throw new UsageError(`${provisional.name} was not installed`);
      }

      const saved =
        change.saveMode === "caret" ? `^${chosen.version}` : chosen.version;
      const manifest = await readRawManifest(directory);
      setDependency(manifest, provisional.name, saved);
      await writeRawManifest(directory, manifest);

      const lockfile = await readLockfile(directory);

      if (lockfile !== undefined) {
        lockfile.root.dependencies[provisional.name] = saved;
        await writeLockfile(directory, lockfile);
      }

      return {
        kind: "add",
        name: provisional.name,
        version: chosen.version,
        saved,
        previous: null,
        changed: changes(existing ?? result.lockfile, result.lockfile),
        lockfile: result.lockfile,
        install: result,
      };
    } catch (error) {
      await writeRawManifest(directory, snapshot);
      throw error;
    }
  }

  if (change.kind === "remove") {
    const previous = removeDependency(original, change.name);

    if (previous === undefined) {
      throw new UsageError(`${change.name} is not declared in package.json`);
    }

    const preferred = preferredVersions(existing, [change.name]);
    await writeRawManifest(directory, original);

    try {
      const result = await install(
        intentFor(directory, existing, preferred),
      );

      return {
        kind: "remove",
        name: change.name,
        version: null,
        saved: null,
        previous,
        changed: changes(existing ?? result.lockfile, result.lockfile),
        lockfile: result.lockfile,
        install: result,
      };
    } catch (error) {
      await writeRawManifest(directory, snapshot);
      throw error;
    }
  }

  if (existing === undefined) {
    throw new LockfileError("no lockfile found; run install first");
  }

  const name = change.name;

  if (
    name !== undefined &&
    existing.packages[name] === undefined &&
    existing.root.dependencies[name] === undefined &&
    existing.root.optionalDependencies[name] === undefined &&
    existing.root.devDependencies[name] === undefined
  ) {
    throw new UsageError(`${name} is not in the dependency tree`);
  }

  const result = await install(
    intentFor(
      directory,
      existing,
      name === undefined ? undefined : preferredVersions(existing, [name]),
    ),
  );

  return {
    kind: "update",
    name: name ?? null,
    version: null,
    saved: null,
    previous: null,
    changed: changes(existing, result.lockfile),
    lockfile: result.lockfile,
    install: result,
  };
}
