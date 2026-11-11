import { AdvisoryService } from "../advisories/service.ts";
import { currentNodeAbi, currentNodeVersion } from "../core/tool.ts";
import { CosignProvenanceVerifier } from "../gate/provenance.ts";
import { BubblewrapSandbox } from "../gate/sandbox.ts";
import {
  createInstaller,
  type Installer,
  type InstallerEnvironment,
  type Registry,
} from "../install/installer.ts";
import { RegistryClient } from "../registry/client.ts";
import type { FallbackSelector } from "../resolve/resolver.ts";
import { ContentStore } from "../store/cas.ts";
import { currentPlatform } from "../store/platform.ts";

export interface CommandInstaller {
  installer: Installer;
  registry: Registry;
}

export function createCommandInstaller(options: {
  allowAdvisories: boolean;
  fallback?: FallbackSelector;
}): CommandInstaller {
  const registry = new RegistryClient();
  const environment: InstallerEnvironment = {
    registry,
    advisoryProvider: new AdvisoryService(),
    provenance: new CosignProvenanceVerifier(),
    sandbox: new BubblewrapSandbox(),
    store: new ContentStore(),
    platform: currentPlatform(),
    clock: () => new Date(),
    concurrency: 8,
    allowAdvisories: options.allowAdvisories,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    nodeVersion: currentNodeVersion(),
    nodeAbi: currentNodeAbi(),
  };

  return { installer: createInstaller(environment), registry };
}
