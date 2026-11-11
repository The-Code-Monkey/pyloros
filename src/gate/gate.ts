import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { GateError, ProvenanceError } from "../core/errors.ts";
import type { LockfilePackage, LockfileProvenance } from "../core/lockfile.ts";
import type { PylorosPolicy } from "../core/manifest.ts";
import { lifecycleScripts } from "./lifecycle.ts";
import type {
  GatePackageReport,
  GateReport,
  GateScriptDecision,
  ProvenanceVerifier,
  SandboxRunner,
} from "./types.ts";

export interface GateRunOptions {
  policy: PylorosPolicy;
  packages: readonly LockfilePackage[];
  directories: ReadonlyMap<string, string>;
  tarballs: ReadonlyMap<string, Uint8Array>;
  storeRoot: string;
  provenance: ProvenanceVerifier;
  sandbox: SandboxRunner;
  expectedProvenance?: ReadonlyMap<string, LockfileProvenance>;
  timeoutMs: number;
}

function scriptEnvironment(): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

export async function runGate(options: GateRunOptions): Promise<GateReport> {
  const provenance = options.provenance;
  const sandbox = options.sandbox;
  const timeoutMs = options.timeoutMs;
  const reports: GatePackageReport[] = [];
  let sandboxChecked = false;

  for (const pkg of [...options.packages].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const directory = options.directories.get(pkg.name);
    const tarball = options.tarballs.get(pkg.name);

    if (directory === undefined || tarball === undefined) {
      throw new GateError(`missing staged content for ${pkg.name}@${pkg.version}`);
    }

    const identity = `${pkg.name}@${pkg.version}`;
    const verification = await provenance.verify({
      name: pkg.name,
      version: pkg.version,
      integrity: pkg.integrity,
      tarball,
    });
    const expected = options.expectedProvenance?.get(identity);

    if (expected !== undefined) {
      if (verification.status !== "verified") {
        throw new ProvenanceError(
          `could not re-verify provenance for ${identity}`,
        );
      }

      if (
        expected.attestationDigest !== undefined &&
        verification.attestationDigest !== expected.attestationDigest
      ) {
        throw new ProvenanceError(
          `attestation digest changed for ${identity}`,
        );
      }

      if (
        expected.subjectIntegrity !== undefined &&
        verification.subjectIntegrity !== expected.subjectIntegrity
      ) {
        throw new ProvenanceError(
          `attestation subject changed for ${identity}`,
        );
      }
    }

    const allow = options.policy.allowScripts[identity];
    const declared = lifecycleScripts(pkg.scripts ?? []);
    const native = existsSync(join(directory, "binding.gyp"));
    const scripts: GateScriptDecision[] = [];

    if (allow === undefined) {
      for (const name of declared) {
        scripts.push({ name, action: "skipped", reason: "not allowlisted" });
      }

      if (native) {
        throw new GateError(
          `${identity} requires a source build; add it to pyloros.allowScripts with a reason`,
        );
      }

      reports.push({
        name: pkg.name,
        version: pkg.version,
        provenance: verification,
        native,
        scripts,
      });
      continue;
    }

    if (native && declared.length === 0) {
      throw new GateError(
        `${identity} requires a source build but declares no lifecycle script`,
      );
    }

    if (declared.length > 0) {
      if (verification.status !== "verified") {
        throw new GateError(
          `${identity} is allowlisted but has no verified provenance`,
        );
      }

      if (!sandboxChecked) {
        if (!(await sandbox.available())) {
          throw new GateError(
            "bubblewrap is not available; refusing to run allowlisted scripts",
          );
        }
        sandboxChecked = true;
      }
    }

    for (const name of declared) {
      const body = pkg.scriptCommands?.[name];

      if (body === undefined) {
        throw new GateError(
          `${identity} ${name} has no recorded script body in the lockfile`,
        );
      }

      const result = await sandbox.run({
        command: "sh",
        args: ["-c", body],
        cwd: "/package",
        env: scriptEnvironment(),
        writable: [{ source: directory, target: "/package" }],
        readOnly: [{ source: options.storeRoot, target: "/store" }],
        timeoutMs,
      });

      if (result.timedOut) {
        throw new GateError(`${identity} ${name} script timed out`);
      }

      if (result.exitCode !== 0) {
        const detail =
          result.stderr === undefined || result.stderr.trim().length === 0
            ? ""
            : `: ${result.stderr.trim()}`;
        throw new GateError(
          `${identity} ${name} script failed with exit ${String(result.exitCode)}${detail}`,
        );
      }

      scripts.push({ name, action: "executed" });
    }

    reports.push({
      name: pkg.name,
      version: pkg.version,
      provenance: verification,
      native,
      reason: allow.reason,
      scripts,
    });
  }

  return { packages: reports };
}
