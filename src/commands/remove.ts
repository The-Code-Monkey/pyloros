import { ExitCode } from "../core/exit-codes.ts";
import { UsageError } from "../core/errors.ts";
import { readLockfile } from "../core/lockfile.ts";
import { installProject, preferredVersions } from "../install/install.ts";
import {
  readRawManifest,
  removeDependency,
  writeRawManifest,
} from "../install/manifest-edit.ts";
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

  const name = flags.positionals[0] as string;
  const original = await readRawManifest(directory);
  const previous = removeDependency(original, name);

  if (previous === undefined) {
    throw new UsageError(`${name} is not declared in package.json`);
  }

  const existing = await readLockfile(directory);
  const preferred = preferredVersions(existing, [name]);

  await writeRawManifest(directory, original);

  try {
    await installProject({
      directory,
      reResolve: true,
      preferred,
      fallback: selectorFor({ select: undefined, allowAdvisories: false }),
    });
  } catch (error) {
    const restored = await readRawManifest(directory);
    restored["dependencies"] = original["dependencies"];
    restored["optionalDependencies"] = original["optionalDependencies"];
    await writeRawManifest(directory, restored);
    throw error;
  }

  if (json) {
    printJson({ ok: true, command: "remove", name, previous });
  } else {
    process.stdout.write(`pyloros: removed ${name}\n`);
  }

  return ExitCode.Ok;
}
