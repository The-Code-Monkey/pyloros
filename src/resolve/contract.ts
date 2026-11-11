import semver from "../core/semver.ts";
import type { VersionManifest } from "../registry/packument.ts";

export type ContractReason = "excluded-version";

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
    return undefined;
  }

  if (semver.validRange(range) === null) {
    return undefined;
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

  return `${identity} requires Node ${violation.range}, not ${violation.nodeVersion}`;
}
