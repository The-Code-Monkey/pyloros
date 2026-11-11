import semver from "../core/semver.ts";
import { LockfileError, UsageError } from "../core/errors.ts";
import {
  readLockfile,
  writeLockfile,
  type Lockfile,
} from "../core/lockfile.ts";
import { parseProjectManifest } from "../core/manifest.ts";
import { RegistryClient } from "../registry/client.ts";
import type { FallbackSelector } from "../resolve/resolver.ts";
import {
  installProject,
  preferredVersions,
  type InstallProjectOptions,
  type InstallProjectResult,
  type Registry,
} from "./install.ts";
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

export type InstallRunner = (
  options: InstallProjectOptions,
) => Promise<InstallProjectResult>;

export interface DependencyChangeOptions {
  registry?: Registry;
  install?: InstallRunner;
  allowAdvisories?: boolean;
  fallback?: FallbackSelector;
  scriptTimeoutMs?: number;
  now?: () => Date;
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
  install: InstallProjectResult;
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

function baseOptions(
  directory: string,
  registry: Registry | undefined,
  options: DependencyChangeOptions,
): InstallProjectOptions {
  return {
    directory,
    reResolve: true,
    ...(registry === undefined ? {} : { registry }),
    ...(options.allowAdvisories === true ? { allowAdvisories: true } : {}),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(options.scriptTimeoutMs === undefined
      ? {}
      : { scriptTimeoutMs: options.scriptTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
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
  options: DependencyChangeOptions = {},
): Promise<DependencyChangeResult> {
  const install = options.install ?? installProject;
  const original = await readRawManifest(directory);
  const snapshot = structuredClone(original);
  parseProjectManifest(directory, structuredClone(original));
  const existing = await readLockfile(directory);

  if (change.kind === "add") {
    const registry = options.registry ?? new RegistryClient();
    const provisional = await provisionalRange(change.spec, registry);
    const preferred = preferredVersions(existing, [provisional.name]);

    setDependency(original, provisional.name, provisional.range);
    await writeRawManifest(directory, original);

    try {
      const result = await install({
        ...baseOptions(directory, registry, options),
        preferred,
      });
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
      const result = await install({
        ...baseOptions(directory, options.registry, options),
        preferred,
      });

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

  const result = await install({
    ...baseOptions(directory, options.registry, options),
    ...(name === undefined
      ? {}
      : { preferred: preferredVersions(existing, [name]) }),
  });

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
