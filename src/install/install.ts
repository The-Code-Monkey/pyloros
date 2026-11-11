import { AdvisoryService } from "../advisories/service.ts";
import type { AdvisoryProvider } from "../advisories/types.ts";
import { CosignProvenanceVerifier } from "../gate/provenance.ts";
import { BubblewrapSandbox } from "../gate/sandbox.ts";
import type { ProvenanceVerifier, SandboxRunner } from "../gate/types.ts";
import { readLockfile, type Lockfile } from "../core/lockfile.ts";
import { currentNodeAbi, currentNodeVersion } from "../core/tool.ts";
import { RegistryClient } from "../registry/client.ts";
import type { FallbackSelector } from "../resolve/resolver.ts";
import { ContentStore } from "../store/cas.ts";
import { currentPlatform, type Platform } from "../store/platform.ts";
import {
  createInstaller,
  type InstallIntent,
  type InstallResult,
  type Registry,
} from "./installer.ts";

export type {
  InstallIntent,
  InstallMode,
  InstallResult,
  Installer,
  InstallerEnvironment,
  Registry,
} from "./installer.ts";

export type InstallProjectResult = InstallResult;

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
  store?: ContentStore;
  platform?: Platform;
  concurrency?: number;
  nodeVersion?: string;
  nodeAbi?: string;
}

export async function installProject(
  options: InstallProjectOptions,
): Promise<InstallProjectResult> {
  const installer = createInstaller({
    registry: options.registry ?? new RegistryClient(),
    advisoryProvider: options.advisoryProvider ?? new AdvisoryService(),
    provenance: options.provenance ?? new CosignProvenanceVerifier(),
    sandbox: options.sandbox ?? new BubblewrapSandbox(),
    store: options.store ?? new ContentStore(),
    platform: options.platform ?? currentPlatform(),
    clock: options.now ?? (() => new Date()),
    concurrency: options.concurrency ?? 8,
    allowAdvisories: options.allowAdvisories === true,
    ...(options.scriptTimeoutMs === undefined
      ? {}
      : { scriptTimeoutMs: options.scriptTimeoutMs }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    nodeVersion: options.nodeVersion ?? currentNodeVersion(),
    nodeAbi: options.nodeAbi ?? currentNodeAbi(),
  });
  const existing = await readLockfile(options.directory);
  const intent: InstallIntent =
    existing === undefined
      ? {
          kind: "resolve",
          directory: options.directory,
          ...(options.preferred === undefined
            ? {}
            : { preferred: options.preferred }),
        }
      : options.reResolve === true
        ? {
            kind: "re-resolve",
            directory: options.directory,
            ...(options.preferred === undefined
              ? {}
              : { preferred: options.preferred }),
          }
        : { kind: "frozen", directory: options.directory };

  return installer.install(intent);
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
