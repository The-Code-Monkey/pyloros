import { ExitCode } from "../core/exit-codes.ts";
import { LockfileError, UsageError } from "../core/errors.ts";
import { readLockfile } from "../core/lockfile.ts";
import { parseFlags, printJson } from "./shared.ts";

const LIFECYCLE = ["preinstall", "install", "postinstall"];

export async function auditCommand(
  args: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  const flags = parseFlags(args, {});

  if (flags.positionals.length > 0) {
    throw new UsageError("audit takes no arguments");
  }

  const lockfile = await readLockfile(directory);

  if (lockfile === undefined) {
    throw new LockfileError("no lockfile found; run install first");
  }

  const advisories = Object.entries(lockfile.advisories.entries).filter(
    ([, list]) => list.length > 0,
  );
  const packages = Object.values(lockfile.packages)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((pkg) => {
      const allowed = pkg.gate?.allowedScripts ?? [];
      const blockedScripts = (pkg.scripts ?? []).filter(
        (script) => LIFECYCLE.includes(script) && !allowed.includes(script),
      );

      return {
        name: pkg.name,
        version: pkg.version,
        provenance: pkg.provenance?.status ?? "absent",
        gate: pkg.gate ?? null,
        blockedScripts,
      };
    });
  const gateIssues = packages.filter(
    (pkg) =>
      pkg.gate !== null && pkg.provenance !== "verified",
  );
  const exitCode =
    advisories.length > 0
      ? ExitCode.AdvisoryBlock
      : gateIssues.length > 0
        ? ExitCode.InstallGate
        : ExitCode.Ok;

  if (json) {
    printJson({
      ok: exitCode === ExitCode.Ok,
      command: "audit",
      exitCode,
      snapshotAt: lockfile.advisories.snapshotAt,
      advisories: advisories.map(([identity, list]) => ({
        identity,
        advisories: list,
      })),
      packages,
    });
  } else if (exitCode === ExitCode.Ok) {
    process.stdout.write(
      `pyloros: no open advisories across ${packages.length} packages\n`,
    );
  } else {
    for (const [identity, list] of advisories) {
      process.stdout.write(
        `pyloros: ${identity}: ${list
          .map((advisory) => `${advisory.id} (${advisory.severity})`)
          .join(", ")}\n`,
      );
    }

    for (const pkg of gateIssues) {
      process.stdout.write(
        `pyloros: ${pkg.name}@${pkg.version} has allowed scripts without verified provenance\n`,
      );
    }
  }

  return exitCode;
}
