import { ExitCode } from "../core/exit-codes.ts";
import { LockfileError, UsageError } from "../core/errors.ts";
import { assertFrozen } from "../core/frozen.ts";
import { LOCKFILE_NAME, readLockfile } from "../core/lockfile.ts";
import { readProjectManifest } from "../core/manifest.ts";
import { TOOL_NAME } from "../core/tool.ts";
import { parseFlags, printJson } from "./shared.ts";

export async function checkCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {});

  if (flags.positionals.length > 0) {
    throw new UsageError("check takes no arguments");
  }

  const manifest = await readProjectManifest(directory);
  const lockfile = await readLockfile(directory);

  if (lockfile === undefined) {
    throw new LockfileError(`no ${LOCKFILE_NAME} found in ${directory}`);
  }

  assertFrozen(manifest, lockfile);

  if (json) {
    printJson({
      ok: true,
      command: "check",
      node: lockfile.node,
      packages: Object.keys(lockfile.packages).length,
    });
  } else {
    process.stdout.write(`${TOOL_NAME}: lockfile is consistent\n`);
  }

  return ExitCode.Ok;
}
