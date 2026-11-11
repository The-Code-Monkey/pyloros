import semver from "./semver.ts";
import { canonicalJson } from "./canonical-json.ts";
import { FrozenDriftError, RuntimeContractError } from "./errors.ts";
import { currentNodeAbi, currentNodeVersion } from "./tool.ts";
import type { ProjectManifest } from "./manifest.ts";
import type { Lockfile } from "./lockfile.ts";

export type FrozenDriftKind =
  | "node-version"
  | "node-abi"
  | "root"
  | "missing-package"
  | "unsatisfied-root";

export interface FrozenDrift {
  kind: FrozenDriftKind;
  message: string;
}

export interface FrozenCheckOptions {
  nodeVersion?: string;
  nodeAbi?: string;
}

function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false });
  } catch {
    return false;
  }
}

export function frozenDrifts(
  manifest: ProjectManifest,
  lockfile: Lockfile,
  options: FrozenCheckOptions = {},
): FrozenDrift[] {
  const nodeVersion = options.nodeVersion ?? currentNodeVersion();
  const nodeAbi = options.nodeAbi ?? currentNodeAbi();
  const drifts: FrozenDrift[] = [];

  if (lockfile.node.version !== nodeVersion) {
    drifts.push({
      kind: "node-version",
      message: `lockfile was resolved for Node ${lockfile.node.version}, current is ${nodeVersion}; run "pyloros install --re-resolve"`,
    });
  }

  if (lockfile.node.abi !== nodeAbi) {
    drifts.push({
      kind: "node-abi",
      message: `lockfile was resolved for ABI ${lockfile.node.abi}, current is ${nodeAbi}; run "pyloros install --re-resolve"`,
    });
  }

  const expectedRoot = canonicalJson({
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    devDependencies: manifest.devDependencies,
  });
  const lockedRoot = canonicalJson({
    dependencies: lockfile.root.dependencies,
    optionalDependencies: lockfile.root.optionalDependencies,
    devDependencies: lockfile.root.devDependencies,
  });

  if (expectedRoot !== lockedRoot) {
    drifts.push({
      kind: "root",
      message: `package.json dependency specs differ from the lockfile; run "pyloros install" to re-resolve`,
    });
  }

  for (const [name, range] of Object.entries({
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.dependencies,
  })) {
    const locked = lockfile.packages[name];

    if (locked === undefined) {
      drifts.push({
        kind: "missing-package",
        message: `root dependency ${name} is missing from the lockfile`,
      });
      continue;
    }

    if (!satisfies(locked.version, range)) {
      drifts.push({
        kind: "unsatisfied-root",
        message: `locked ${name}@${locked.version} does not satisfy the root range ${range}`,
      });
    }
  }

  return drifts;
}

export function assertFrozen(
  manifest: ProjectManifest,
  lockfile: Lockfile,
  options: FrozenCheckOptions = {},
): void {
  const drifts = frozenDrifts(manifest, lockfile, options);
  const nodeDrifts = drifts.filter(
    (drift) => drift.kind === "node-version" || drift.kind === "node-abi",
  );

  if (nodeDrifts.length > 0) {
    throw new RuntimeContractError(
      nodeDrifts.map((drift) => drift.message).join("; "),
    );
  }

  if (drifts.length > 0) {
    throw new FrozenDriftError(drifts.map((drift) => drift.message).join("; "));
  }
}
