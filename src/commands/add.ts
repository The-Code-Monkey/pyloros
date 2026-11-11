import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { applyDependencyChange } from "../install/dependency-change.ts";
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

  const allowAdvisories = flags.booleans.has("--allow-advisories");
  const result = await applyDependencyChange(
    directory,
    {
      kind: "add",
      spec: flags.positionals[0] as string,
      saveMode: flags.booleans.has("--range") ? "caret" : "exact",
    },
    {
      allowAdvisories,
      fallback: selectorFor({
        select: flags.values.get("--select"),
        allowAdvisories,
      }),
    },
  );

  if (json) {
    printJson({
      ok: true,
      command: "add",
      name: result.name,
      version: result.version,
      saved: result.saved,
    });
  } else {
    process.stdout.write(
      `pyloros: added ${result.name}@${result.version} (saved as ${result.saved})\n`,
    );
  }

  return ExitCode.Ok;
}
