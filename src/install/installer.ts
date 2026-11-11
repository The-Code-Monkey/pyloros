import type { AdvisoryProvider } from "../advisories/types.ts";
import { LockfileError } from "../core/errors.ts";
import { assertFrozen } from "../core/frozen.ts";
import {
  createLockfile,
  readLockfile,
  writeLockfile,
  type Lockfile,
} from "../core/lockfile.ts";
import { readProjectManifest } from "../core/manifest.ts";
import type { ProvenanceVerifier, SandboxRunner } from "../gate/types.ts";
import {
  resolve,
  type FallbackSelector,
  type PackumentProvider,
  type Resolution,
} from "../resolve/resolver.ts";
import type { ContentStore } from "../store/cas.ts";
import type { TarballSource } from "../store/materialize.ts";
import { materialize, type MaterializeResult } from "../store/materialize.ts";
import type { Platform } from "../store/platform.ts";
import { applyGateReport, expectedProvenance } from "./gate-report.ts";

export interface Registry extends PackumentProvider, TarballSource {}

export type InstallMode = "frozen" | "resolve" | "re-resolve";

export interface InstallerEnvironment {
  registry: Registry;
  advisoryProvider: AdvisoryProvider;
  provenance: ProvenanceVerifier;
  sandbox: SandboxRunner;
  store: ContentStore;
  platform: Platform;
  clock: () => Date;
  concurrency: number;
  scriptTimeoutMs?: number;
  allowAdvisories: boolean;
  fallback?: FallbackSelector;
  nodeVersion: string;
  nodeAbi: string;
}

interface InstallIntentBase {
  directory: string;
}

export type InstallIntent =
  | (InstallIntentBase & { kind: "frozen" })
  | (InstallIntentBase & {
      kind: "resolve";
      preferred?: Readonly<Record<string, string>>;
    })
  | (InstallIntentBase & {
      kind: "re-resolve";
      preferred?: Readonly<Record<string, string>>;
    });

export interface InstallResult {
  mode: InstallMode;
  lockfile: Lockfile;
  wroteLockfile: boolean;
  resolution?: Resolution;
  materialize: MaterializeResult;
}

export interface Installer {
  install(intent: InstallIntent): Promise<InstallResult>;
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

export function createInstaller(environment: InstallerEnvironment): Installer {
  return {
    async install(intent: InstallIntent): Promise<InstallResult> {
      const manifest = await readProjectManifest(intent.directory);
      const existing = await readLockfile(intent.directory);

      if (intent.kind === "frozen") {
        if (existing === undefined) {
          throw new LockfileError(
            "no lockfile found; run a resolving install first",
          );
        }

        assertFrozen(manifest, existing, {
          nodeVersion: environment.nodeVersion,
          nodeAbi: environment.nodeAbi,
        });

        const expected = expectedProvenance(existing);
        const materialized = await materialize({
          projectDirectory: intent.directory,
          lockfile: existing,
          registry: environment.registry,
          policy: manifest.policy,
          provenance: frozenVerifier(environment.provenance, expected),
          sandbox: environment.sandbox,
          expectedProvenance: expected,
          store: environment.store,
          platform: environment.platform,
          concurrency: environment.concurrency,
          now: environment.clock,
          ...(environment.scriptTimeoutMs === undefined
            ? {}
            : { scriptTimeoutMs: environment.scriptTimeoutMs }),
        });

        return {
          mode: "frozen",
          lockfile: existing,
          wroteLockfile: false,
          materialize: materialized,
        };
      }

      const mode: InstallMode =
        intent.kind === "re-resolve" && existing !== undefined
          ? "re-resolve"
          : "resolve";
      const resolution = await resolve(manifest, environment.registry, {
        nodeVersion: environment.nodeVersion,
        advisoryProvider: environment.advisoryProvider,
        now: environment.clock,
        ...(environment.fallback === undefined
          ? {}
          : { fallback: environment.fallback }),
        ...(environment.allowAdvisories ? { allowAdvisories: true } : {}),
        ...(intent.preferred === undefined ? {} : { preferred: intent.preferred }),
      });
      const created = createLockfile(manifest, resolution, {
        nodeAbi: environment.nodeAbi,
      });
      const materialized = await materialize({
        projectDirectory: intent.directory,
        lockfile: created,
        registry: environment.registry,
        policy: manifest.policy,
        provenance: environment.provenance,
        sandbox: environment.sandbox,
        store: environment.store,
        platform: environment.platform,
        concurrency: environment.concurrency,
        now: environment.clock,
        ...(environment.scriptTimeoutMs === undefined
          ? {}
          : { scriptTimeoutMs: environment.scriptTimeoutMs }),
      });
      const lockfile = applyGateReport(created, materialized.gate);

      await writeLockfile(intent.directory, lockfile);

      return {
        mode,
        lockfile,
        wroteLockfile: true,
        resolution,
        materialize: materialized,
      };
    },
  };
}
