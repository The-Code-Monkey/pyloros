import { AdvisoryService } from "../advisories/service.ts";
import { currentNodeAbi, currentNodeVersion } from "../core/tool.ts";
import { CosignProvenanceVerifier } from "../gate/provenance.ts";
import { BubblewrapSandbox } from "../gate/sandbox.ts";
import {
  createInstallSession,
  type InstallSession,
  type InstallSessionEnvironment,
  type Registry,
} from "../install/install-session.ts";
import { RegistryClient } from "../registry/client.ts";
import type { FallbackSelector } from "../resolve/resolver.ts";
import { ContentStore } from "../store/cas.ts";
import { currentPlatform } from "../store/platform.ts";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CommandInstallSession {
  session: InstallSession;
  registry: Registry;
  environment: InstallSessionEnvironment;
}

export function createCommandInstallSession(options: {
  allowAdvisories: boolean;
  fallback?: FallbackSelector;
}): CommandInstallSession {
  const registry = new RegistryClient();
  const environment: InstallSessionEnvironment = {
    registry,
    advisoryProvider: new AdvisoryService(),
    provenance: new CosignProvenanceVerifier(),
    sandbox: new BubblewrapSandbox(),
    store: new ContentStore(),
    platform: currentPlatform(),
    clock: () => new Date(),
    concurrency: 8,
    scriptTimeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
    allowAdvisories: options.allowAdvisories,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    nodeVersion: currentNodeVersion(),
    nodeAbi: currentNodeAbi(),
  };

  return {
    session: createInstallSession(environment),
    registry,
    environment,
  };
}
