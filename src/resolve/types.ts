import type { Advisory, AdvisorySnapshot } from "../advisories/types.ts";
import type { VersionManifest } from "../registry/packument.ts";

export interface ResolvedPackage {
  name: string;
  version: string;
  manifest: VersionManifest;
}

export interface OverridePin {
  name: string;
  version: string;
  reason: string;
  createdAt: string;
  advisoryIds: string[];
  constraints: string[];
}

export interface FallbackCandidate {
  version: string;
  advisories: readonly Advisory[];
  satisfiesConstraints: boolean;
  deprecated?: string;
}

export interface FallbackRequest {
  name: string;
  nodeVersion: string;
  constraints: readonly string[];
  candidates: readonly FallbackCandidate[];
  allowAdvisories: boolean;
}

export interface FallbackChoice {
  version: string;
  reason: string;
}

export type FallbackSelector = (
  request: FallbackRequest,
) => Promise<FallbackChoice | undefined>;

export interface Resolution {
  nodeVersion: string;
  packages: ResolvedPackage[];
  advisories: AdvisorySnapshot;
  overrides: OverridePin[];
}
