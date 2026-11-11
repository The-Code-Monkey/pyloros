import semver from "../core/semver.ts";
import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { readLockfile, writeLockfile } from "../core/lockfile.ts";
import { RegistryClient } from "../registry/client.ts";
import { installProject, preferredVersions } from "../install/install.ts";
import {
  readRawManifest,
  setDependency,
  writeRawManifest,
} from "../install/manifest-edit.ts";
import { parsePackageSpec } from "../install/package-spec.ts";
import { parseFlags, printJson, selectorFor } from "./shared.ts";

export async function addCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {
    booleans: ["--range", "--allow-advisories"],
    values: ["--select"],
  });

  if (flags.positionals.length !== 1) {
    throw new UsageError("add needs exactly one package specifier");
  }

  const spec = parsePackageSpec(flags.positionals[0] as string);
  const original = await readRawManifest(directory);
  const existing = await readLockfile(directory);
  const registry = new RegistryClient();
  const packument = await registry.getPackument(spec.name);
  const tags = packument["dist-tags"] ?? {};
  let provisional: string;

  if (spec.range === undefined) {
    const latest = tags["latest"];

    if (latest === undefined) {
      throw new UsageError(`${spec.name} has no latest dist-tag`);
    }

    provisional = latest;
  } else if (semver.validRange(spec.range) !== null) {
    provisional = spec.range;
  } else {
    const tagged = tags[spec.range];

    if (tagged === undefined) {
      throw new UsageError(
        `${spec.name} has no dist-tag named ${spec.range}`,
      );
    }

    provisional = tagged;
  }

  const allowAdvisories = flags.booleans.has("--allow-advisories");
  const preferred = preferredVersions(existing, [spec.name]);

  setDependency(original, spec.name, provisional);
  await writeRawManifest(directory, original);

  try {
    const result = await installProject({
      directory,
      registry,
      reResolve: true,
      preferred,
      allowAdvisories,
      fallback: selectorFor({
        select: flags.values.get("--select"),
        allowAdvisories,
      }),
    });
    const chosen = result.lockfile.packages[spec.name];

    if (chosen === undefined) {
      throw new UsageError(`${spec.name} was not installed`);
    }

    const saved = flags.booleans.has("--range")
      ? `^${chosen.version}`
      : chosen.version;
    const manifest = await readRawManifest(directory);
    setDependency(manifest, spec.name, saved);
    await writeRawManifest(directory, manifest);

    const lockfile = await readLockfile(directory);

    if (lockfile !== undefined) {
      lockfile.root.dependencies[spec.name] = saved;
      await writeLockfile(directory, lockfile);
    }

    if (json) {
      printJson({
        ok: true,
        command: "add",
        name: spec.name,
        version: chosen.version,
        saved,
      });
    } else {
      process.stdout.write(
        `pyloros: added ${spec.name}@${chosen.version} (saved as ${saved})\n`,
      );
    }

    return ExitCode.Ok;
  } catch (error) {
    await writeRawManifest(directory, original);
    throw error;
  }
}
