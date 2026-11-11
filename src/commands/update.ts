import { ExitCode } from "../core/exit-codes.ts";
import { LockfileError, UsageError } from "../core/errors.ts";
import { readLockfile, type Lockfile } from "../core/lockfile.ts";
import { installProject, preferredVersions } from "../install/install.ts";
import { parseFlags, printJson, selectorFor } from "./shared.ts";

interface Change {
  name: string;
  from: string | null;
  to: string | null;
}

function changes(before: Lockfile, after: Lockfile): Change[] {
  const names = new Set([
    ...Object.keys(before.packages),
    ...Object.keys(after.packages),
  ]);
  const result: Change[] = [];

  for (const name of [...names].sort()) {
    const from = before.packages[name]?.version ?? null;
    const to = after.packages[name]?.version ?? null;

    if (from !== to) {
      result.push({ name, from, to });
    }
  }

  return result;
}

export async function updateCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {
    booleans: ["--allow-advisories"],
    values: ["--select"],
  });

  if (flags.positionals.length > 1) {
    throw new UsageError("update accepts at most one package name");
  }

  const existing = await readLockfile(directory);

  if (existing === undefined) {
    throw new LockfileError("no lockfile found; run install first");
  }

  const name = flags.positionals[0];

  if (
    name !== undefined &&
    existing.packages[name] === undefined &&
    existing.root.dependencies[name] === undefined &&
    existing.root.optionalDependencies[name] === undefined
  ) {
    throw new UsageError(`${name} is not in the dependency tree`);
  }

  const allowAdvisories = flags.booleans.has("--allow-advisories");
  const result = await installProject({
    directory,
    reResolve: true,
    preferred: name === undefined ? undefined : preferredVersions(existing, [name]),
    allowAdvisories,
    fallback: selectorFor({
      select: flags.values.get("--select"),
      allowAdvisories,
    }),
  });
  const updated = changes(existing, result.lockfile);

  if (json) {
    printJson({ ok: true, command: "update", name: name ?? null, changed: updated });
  } else if (updated.length === 0) {
    process.stdout.write("pyloros: nothing to update\n");
  } else {
    for (const change of updated) {
      process.stdout.write(
        `pyloros: ${change.name} ${change.from ?? "(new)"} -> ${change.to ?? "(removed)"}\n`,
      );
    }
  }

  return ExitCode.Ok;
}
