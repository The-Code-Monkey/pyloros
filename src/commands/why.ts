import { ExitCode } from "../core/exit-codes.ts";
import { LockfileError, UsageError } from "../core/errors.ts";
import { readLockfile } from "../core/lockfile.ts";
import { parseFlags, printJson } from "./shared.ts";

export async function whyCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {});

  if (flags.positionals.length !== 1) {
    throw new UsageError("why needs exactly one package name");
  }

  const name = flags.positionals[0] as string;
  const lockfile = await readLockfile(directory);

  if (lockfile === undefined) {
    throw new LockfileError("no lockfile found; run install first");
  }

  const pkg = lockfile.packages[name];

  if (pkg === undefined) {
    throw new UsageError(`${name} is not in the dependency tree`);
  }

  const identity = `${pkg.name}@${pkg.version}`;
  const rootRange = lockfile.root.dependencies[name] ?? lockfile.root.optionalDependencies[name];
  const overrides = lockfile.overrides.filter((override) => override.name === name);
  const advisories = lockfile.advisories.entries[identity] ?? [];
  const allowedScripts = pkg.gate?.allowedScripts ?? [];
  const blockedScripts = (pkg.scripts ?? []).filter(
    (script) => !allowedScripts.includes(script),
  );

  if (json) {
    printJson({
      ok: true,
      command: "why",
      name,
      version: pkg.version,
      rootRange: rootRange ?? null,
      overrides,
      advisories,
      provenance: pkg.provenance?.status ?? "absent",
      gate: pkg.gate ?? null,
      blockedScripts,
    });
  } else {
    process.stdout.write(`pyloros: ${identity}\n`);

    if (rootRange !== undefined) {
      process.stdout.write(`pyloros: root range ${rootRange}\n`);
    }

    for (const override of overrides) {
      process.stdout.write(
        `pyloros: override ${override.reason} (${override.constraints.join(", ")})\n`,
      );
    }

    for (const advisory of advisories) {
      process.stdout.write(
        `pyloros: advisory ${advisory.id} (${advisory.severity}) ${advisory.url}\n`,
      );
    }

    process.stdout.write(
      `pyloros: provenance ${pkg.provenance?.status ?? "absent"}\n`,
    );

    if (pkg.gate !== null && pkg.gate !== undefined) {
      process.stdout.write(
        `pyloros: allowed scripts ${pkg.gate.allowedScripts.join(", ")} (${pkg.gate.reason})\n`,
      );
    }

    if (blockedScripts.length > 0) {
      process.stdout.write(
        `pyloros: blocked scripts ${blockedScripts.join(", ")}\n`,
      );
    }
  }

  return ExitCode.Ok;
}
