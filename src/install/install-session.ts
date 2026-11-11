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
import type {
  MaterializeOptions,
  TarballSource,
} from "../store/materialize.ts";
import { materialize, type MaterializeResult } from "../store/materialize.ts";
import type { Platform } from "../store/platform.ts";
import { applyGateReport, expectedProvenance } from "./gate-report.ts";

export interface Registry extends PackumentProvider, TarballSource {}

export type InstallMode = "frozen" | "resolve" | "re-resolve";

export interface InstallSessionEnvironment {
  registry: Registry;
  advisoryProvider: AdvisoryProvider;
  provenance: ProvenanceVerifier;
  sandbox: SandboxRunner;
  store: ContentStore;
  platform: Platform;
  clock: () => Date;
  concurrency: number;
  scriptTimeoutMs: number;
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

export interface InstallSession {
  install(intent: InstallIntent): Promise<InstallResult>;
}

export function installIntentFor(
  directory: string,
  existing: Lockfile | undefined,
  fallback: "frozen" | "re-resolve",
  preferred?: Readonly<Record<string, string>>,
): InstallIntent {
  if (existing === undefined) {
    return preferred === undefined
      ? { kind: "resolve", directory }
      : { kind: "resolve", directory, preferred };
  }

  if (fallback === "frozen") {
    return { kind: "frozen", directory };
  }

  return preferred === undefined
    ? { kind: "re-resolve", directory }
    : { kind: "re-resolve", directory, preferred };
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

function materializeOptions(
  environment: InstallSessionEnvironment,
  intent: InstallIntent,
  lockfile: Lockfile,
  policy: MaterializeOptions["policy"],
): MaterializeOptions {
  return {
    projectDirectory: intent.directory,
    lockfile,
    registry: environment.registry,
    policy,
    provenance: environment.provenance,
    sandbox: environment.sandbox,
    store: environment.store,
    platform: environment.platform,
    concurrency: environment.concurrency,
    now: environment.clock,
    scriptTimeoutMs: environment.scriptTimeoutMs,
  };
}

export function createInstallSession(
  environment: InstallSessionEnvironment,
): InstallSession {
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
          ...materializeOptions(environment, intent, existing, manifest.policy),
          provenance: frozenVerifier(environment.provenance, expected),
          expectedProvenance: expected,
        });

        return {
          mode: "frozen",
          lockfile: existing,
          wroteLockfile: false,
          materialize: materialized,
        };
      }

      if (intent.kind === "re-resolve" && existing === undefined) {
        throw new LockfileError(
          "no lockfile found; re-resolve needs an existing lockfile",
        );
      }

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
      const materialized = await materialize(
        materializeOptions(environment, intent, created, manifest.policy),
      );
      const lockfile = applyGateReport(created, materialized.gate);

      await writeLockfile(intent.directory, lockfile);

      return {
        mode: intent.kind === "re-resolve" ? "re-resolve" : "resolve",
        lockfile,
        wroteLockfile: true,
        resolution,
        materialize: materialized,
      };
    },
  };
}
