import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { parseFlags, printJson } from "./shared.ts";

export async function initCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {});

  if (flags.positionals.length > 0) {
    throw new UsageError("init takes no arguments");
  }

  const target = join(directory, "package.json");

  try {
    await readFile(target);
    throw new UsageError("package.json already exists");
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }

    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const value = {
    name: basename(directory) || "pyloros-project",
    version: "1.0.0",
    private: true,
    type: "module",
    engines: { node: ">=22" },
    pyloros: { allowScripts: {}, pins: {}, allowAdvisories: [] },
  };
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o644,
  });
  await rename(temporary, target);

  if (json) {
    printJson({ ok: true, command: "init", manifest: target });
  } else {
    process.stdout.write(`pyloros: created ${target}\n`);
  }

  return ExitCode.Ok;
}
