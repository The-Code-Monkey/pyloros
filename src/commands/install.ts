import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { installProject } from "../install/install.ts";
import { parseFlags, printJson, scriptSummary, selectorFor } from "./shared.ts";

interface ScriptLines {
  executed: string[];
  skipped: string[];
}

function collectScripts(result: Awaited<ReturnType<typeof installProject>>): ScriptLines {
  const executed: string[] = [];
  const skipped: string[] = [];

  for (const pkg of result.materialize.gate.packages) {
    for (const script of pkg.scripts) {
      const label = `${pkg.name}@${pkg.version} ${script.name}`;

      if (script.action === "executed") {
        executed.push(label);
      } else {
        skipped.push(label);
      }
    }
  }

  return { executed, skipped };
}

export async function installCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {
    booleans: ["--re-resolve", "--allow-advisories"],
    values: ["--select"],
  });

  if (flags.positionals.length > 0) {
    throw new UsageError("install takes no positional arguments");
  }

  const allowAdvisories = flags.booleans.has("--allow-advisories");
  const result = await installProject({
    directory,
    reResolve: flags.booleans.has("--re-resolve"),
    allowAdvisories,
    fallback: selectorFor({
      select: flags.values.get("--select"),
      allowAdvisories,
    }),
  });
  const scripts = collectScripts(result);

  if (json) {
    printJson({
      ok: true,
      command: "install",
      mode: result.mode,
      wroteLockfile: result.wroteLockfile,
      installed: result.materialize.installed,
      skipped: result.materialize.skipped,
      scripts,
      overrides: result.lockfile.overrides,
    });
  } else {
    process.stdout.write(
      `pyloros: ${result.mode} install of ${result.materialize.installed.length} packages\n`,
    );

    if (result.materialize.skipped.length > 0) {
      process.stdout.write(
        `pyloros: skipped platform variants: ${result.materialize.skipped.join(", ")}\n`,
      );
    }

    scriptSummary(scripts);
  }

  return ExitCode.Ok;
}
