import semver from "../core/semver.ts";
import type { VersionManifest } from "../registry/packument.ts";

export type ContractReason = "missing-engines" | "invalid-range" | "excluded-version";

export interface ContractViolation {
  package: string;
  version: string;
  nodeVersion: string;
  reason: ContractReason;
  range?: string;
}

export function checkRuntimeContract(
  name: string,
  manifest: VersionManifest,
  nodeVersion: string,
): ContractViolation | undefined {
  const range = manifest.engines?.node;

  if (typeof range !== "string" || range.trim().length === 0) {
    return {
      package: name,
      version: manifest.version,
      nodeVersion,
      reason: "missing-engines",
    };
  }

  if (semver.validRange(range) === null) {
    return {
      package: name,
      version: manifest.version,
      nodeVersion,
      reason: "invalid-range",
      range,
    };
  }

  if (!semver.satisfies(nodeVersion, range, { includePrerelease: true })) {
    return {
      package: name,
      version: manifest.version,
      nodeVersion,
      reason: "excluded-version",
      range,
    };
  }

  return undefined;
}

export function describeViolation(violation: ContractViolation): string {
  const identity = `${violation.package}@${violation.version}`;

  switch (violation.reason) {
    case "missing-engines":
      return `${identity} declares no engines.node`;
    case "invalid-range":
      return `${identity} declares an invalid engines.node range: ${JSON.stringify(violation.range)}`;
    case "excluded-version":
      return `${identity} requires Node ${violation.range}, not ${violation.nodeVersion}`;
  }
}
