import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { AdvisoryService } from "../src/advisories/service.ts";
import { defaultCacheDir, defaultRegistry } from "../src/core/config.ts";
import { currentNodeAbi, currentNodeVersion } from "../src/core/tool.ts";
import { CosignProvenanceVerifier } from "../src/gate/provenance.ts";
import { BubblewrapSandbox } from "../src/gate/sandbox.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { ContentStore } from "../src/store/cas.ts";
import { currentPlatform } from "../src/store/platform.ts";
import {
  createCommandInstallSession,
  DEFAULT_SCRIPT_TIMEOUT_MS,
} from "../src/commands/environment.ts";

test("command install session wires production defaults", () => {
  const { environment } = createCommandInstallSession({ allowAdvisories: false });

  assert.ok(environment.registry instanceof RegistryClient);
  assert.equal(environment.registry.registry, defaultRegistry());
  assert.ok(environment.advisoryProvider instanceof AdvisoryService);
  assert.ok(environment.provenance instanceof CosignProvenanceVerifier);
  assert.ok(environment.sandbox instanceof BubblewrapSandbox);
  assert.ok(environment.store instanceof ContentStore);
  assert.equal(environment.store.root, join(defaultCacheDir(), "store"));
  assert.deepEqual(environment.platform, currentPlatform());
  assert.equal(environment.scriptTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS);
  assert.equal(environment.nodeVersion, currentNodeVersion());
  assert.equal(environment.nodeAbi, currentNodeAbi());
});
