import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { applyDependencyChange } from "../install/dependency-change.ts";
import { createCommandInstallSession } from "./environment.ts";
import { parseFlags, printJson, selectorFor } from "./shared.ts";

export async function removeCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {});

  if (flags.positionals.length !== 1) {
    throw new UsageError("remove needs exactly one package name");
  }

  const { session } = createCommandInstallSession({
    allowAdvisories: false,
    fallback: selectorFor({ select: undefined, allowAdvisories: false }),
  });
  const result = await applyDependencyChange(
    directory,
    { kind: "remove", name: flags.positionals[0] as string },
    { install: session.install },
  );

  if (json) {
    printJson({
      ok: true,
      command: "remove",
      name: result.name,
      previous: result.previous,
    });
  } else {
    process.stdout.write(`pyloros: removed ${result.name}\n`);
  }

  return ExitCode.Ok;
}
