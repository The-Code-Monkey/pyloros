import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { applyDependencyChange } from "../install/dependency-change.ts";
import { createCommandInstaller } from "./environment.ts";
import { parseFlags, printJson, selectorFor } from "./shared.ts";

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

  const allowAdvisories = flags.booleans.has("--allow-advisories");
  const name = flags.positionals[0];
  const { installer } = createCommandInstaller({
    allowAdvisories,
    fallback: selectorFor({
      select: flags.values.get("--select"),
      allowAdvisories,
    }),
  });
  const result = await applyDependencyChange(
    directory,
    name === undefined ? { kind: "update" } : { kind: "update", name },
    { install: (intent) => installer.install(intent) },
  );

  if (json) {
    printJson({
      ok: true,
      command: "update",
      name: result.name,
      changed: result.changed,
    });
  } else if (result.changed.length === 0) {
    process.stdout.write("pyloros: nothing to update\n");
  } else {
    for (const change of result.changed) {
      process.stdout.write(
        `pyloros: ${change.name} ${change.from ?? "(new)"} -> ${change.to ?? "(removed)"}\n`,
      );
    }
  }

  return ExitCode.Ok;
}
