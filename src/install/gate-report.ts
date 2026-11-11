import type { GateReport } from "../gate/types.ts";
import type {
  Lockfile,
  LockfilePackage,
  LockfileProvenance,
} from "../core/lockfile.ts";

export function applyGateReport(
  lockfile: Lockfile,
  report: GateReport,
): Lockfile {
  const packages: Record<string, LockfilePackage> = { ...lockfile.packages };

  for (const entry of report.packages) {
    const existing = packages[entry.name];

    if (existing === undefined) {
      continue;
    }

    const executed = entry.scripts
      .filter((script) => script.action === "executed")
      .map((script) => script.name);
    const provenance: LockfileProvenance = { ...entry.provenance };

    packages[entry.name] = {
      ...existing,
      provenance,
      ...(executed.length > 0 && entry.reason !== undefined
        ? {
            gate: {
              allowedScripts: executed,
              reason: entry.reason,
            },
          }
        : {}),
    };
  }

  return { ...lockfile, packages };
}

export function expectedProvenance(
  lockfile: Lockfile,
): Map<string, LockfileProvenance> {
  const expected = new Map<string, LockfileProvenance>();

  for (const pkg of Object.values(lockfile.packages)) {
    if (
      pkg.gate !== undefined &&
      pkg.gate.allowedScripts.length > 0 &&
      pkg.provenance?.status === "verified"
    ) {
      expected.set(`${pkg.name}@${pkg.version}`, pkg.provenance);
    }
  }

  return expected;
}
