import { AdvisoryService } from "../advisories/service.ts";
import type { AdvisoryProvider } from "../advisories/types.ts";
import { CosignProvenanceVerifier } from "../gate/provenance.ts";
import { BubblewrapSandbox } from "../gate/sandbox.ts";
import type { ProvenanceVerifier, SandboxRunner } from "../gate/types.ts";
import { assertFrozen } from "../core/frozen.ts";
import {
  createLockfile,
  readLockfile,
  writeLockfile,
  type Lockfile,
} from "../core/lockfile.ts";
import { readProjectManifest } from "../core/manifest.ts";
import { currentNodeAbi, currentNodeVersion } from "../core/tool.ts";
import { RegistryClient } from "../registry/client.ts";
import {
  resolve,
  type FallbackSelector,
  type PackumentProvider,
  type Resolution,
} from "../resolve/resolver.ts";
import type { TarballSource } from "../store/materialize.ts";
import { materialize, type MaterializeResult } from "../store/materialize.ts";
import {
  applyGateReport,
  expectedProvenance,
} from "./gate-report.ts";

export interface Registry extends PackumentProvider, TarballSource {}

export type InstallMode = "frozen" | "resolve" | "re-resolve";

export interface InstallProjectOptions {
  directory: string;
  registry?: Registry;
  advisoryProvider?: AdvisoryProvider;
  provenance?: ProvenanceVerifier;
  sandbox?: SandboxRunner;
  fallback?: FallbackSelector;
  allowAdvisories?: boolean;
  reResolve?: boolean;
  preferred?: Readonly<Record<string, string>>;
  scriptTimeoutMs?: number;
  now?: () => Date;
}

export interface InstallProjectResult {
  mode: InstallMode;
  lockfile: Lockfile;
  wroteLockfile: boolean;
  resolution?: Resolution;
  materialize: MaterializeResult;
}

function frozenVerifier(
  verifier: ProvenanceVerifier,
  expected: ReturnType<typeof expectedProvenance>,
): ProvenanceVerifier {
  return {
    async verify(request) {
      const key = `${request.name}@${request.version}`;

      if (!expected.has(key)) {
        return { status: "absent" };
      }

      return verifier.verify(request);
    },
  };
}

export async function installProject(
  options: InstallProjectOptions,
): Promise<InstallProjectResult> {
  const manifest = await readProjectManifest(options.directory);
  const existing = await readLockfile(options.directory);
  const registry = options.registry ?? new RegistryClient();
  const provenance = options.provenance ?? new CosignProvenanceVerifier();
  const sandbox = options.sandbox ?? new BubblewrapSandbox();
  const now = options.now ?? (() => new Date());

  if (existing !== undefined && options.reResolve !== true) {
    assertFrozen(manifest, existing);

    const expected = expectedProvenance(existing);
    const materialized = await materialize({
      projectDirectory: options.directory,
      lockfile: existing,
      registry,
      policy: manifest.policy,
      provenance: frozenVerifier(provenance, expected),
      sandbox,
      expectedProvenance: expected,
      now,
      ...(options.scriptTimeoutMs === undefined
        ? {}
        : { scriptTimeoutMs: options.scriptTimeoutMs }),
    });

    return {
      mode: "frozen",
      lockfile: existing,
      wroteLockfile: false,
      materialize: materialized,
    };
  }

  const mode: InstallMode =
    existing === undefined ? "resolve" : "re-resolve";
  const advisoryProvider =
    options.advisoryProvider ?? new AdvisoryService();
  const resolution = await resolve(manifest, registry, {
    nodeVersion: currentNodeVersion(),
    advisoryProvider,
    now,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(options.allowAdvisories === true ? { allowAdvisories: true } : {}),
    ...(options.preferred === undefined ? {} : { preferred: options.preferred }),
  });
  const created = createLockfile(manifest, resolution, {
    nodeAbi: currentNodeAbi(),
  });
  const materialized = await materialize({
    projectDirectory: options.directory,
    lockfile: created,
    registry,
    policy: manifest.policy,
    provenance,
    sandbox,
    now,
    ...(options.scriptTimeoutMs === undefined
      ? {}
      : { scriptTimeoutMs: options.scriptTimeoutMs }),
  });
  const lockfile = applyGateReport(created, materialized.gate);

  await writeLockfile(options.directory, lockfile);

  return {
    mode,
    lockfile,
    wroteLockfile: true,
    resolution,
    materialize: materialized,
  };
}

export function preferredVersions(
  lockfile: Lockfile | undefined,
  exclude: readonly string[] = [],
): Record<string, string> {
  const preferred: Record<string, string> = {};

  if (lockfile === undefined) {
    return preferred;
  }

  for (const pkg of Object.values(lockfile.packages)) {
    if (!exclude.includes(pkg.name)) {
      preferred[pkg.name] = pkg.version;
    }
  }

  return preferred;
}
