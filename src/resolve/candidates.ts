import semver from "../core/semver.ts";
import type { Packument, VersionManifest } from "../registry/packument.ts";
import {
  advisoryKey,
  type Advisory,
  type AdvisoryQuery,
} from "../advisories/types.ts";
import {
  checkRuntimeContract,
  describeViolation,
  type ContractViolation,
} from "./contract.ts";
import type {
  FallbackCandidate,
  FallbackSelector,
  OverridePin,
} from "./types.ts";

export interface CandidateConstraint {
  range: string;
  from: string;
}

export interface CandidateFailure {
  kind: "resolution" | "contract" | "advisory";
  message: string;
}

export type CandidateOutcome =
  | { kind: "candidates"; candidates: VersionManifest[] }
  | { kind: "override"; manifest: VersionManifest; pin: OverridePin }
  | { kind: "failure"; failure: CandidateFailure };

export interface CandidateContext {
  nodeVersion: string;
  allowAdvisories: boolean;
  now: () => Date;
  preferred?: Readonly<Record<string, string>>;
  fallback?: FallbackSelector;
  queryAdvisories(
    queries: readonly AdvisoryQuery[],
  ): Promise<ReadonlyMap<string, readonly Advisory[]>>;
}

function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false });
  } catch {
    return false;
  }
}

function preferLocked(
  candidates: VersionManifest[],
  preferred: string | undefined,
): void {
  if (preferred === undefined) {
    return;
  }

  const index = candidates.findIndex(
    (candidate) => candidate.version === preferred,
  );

  if (index > 0) {
    const [candidate] = candidates.splice(index, 1);

    if (candidate !== undefined) {
      candidates.unshift(candidate);
    }
  }
}

function conflictMessage(
  name: string,
  constraints: readonly CandidateConstraint[],
  packument: Packument,
): string {
  const sources = constraints
    .map((constraint) => `${constraint.range} (${constraint.from})`)
    .join(", ");
  const available = Object.keys(packument.versions).join(", ");

  return `cannot select one version of ${name} satisfying ${sources}; available versions: ${available}`;
}

function contractMessage(violations: readonly ContractViolation[]): string {
  const details = violations.slice(0, 5).map(describeViolation).join("; ");
  const more = violations.length > 5 ? `; and ${violations.length - 5} more` : "";
  return `no version satisfies the Runtime Contract: ${details}${more}`;
}

function advisoryMessage(
  name: string,
  candidates: readonly FallbackCandidate[],
): string {
  const affected = candidates.filter(
    (candidate) => candidate.advisories.length > 0,
  );

  if (affected.length === 0) {
    return `no clean version of ${name} is available`;
  }

  const details = affected
    .slice(0, 5)
    .map(
      (candidate) =>
        `${name}@${candidate.version}: ${candidate.advisories
          .map((advisory) => advisory.id)
          .join(", ")}`,
    )
    .join("; ");

  return `every candidate version of ${name} has an open security advisory: ${details}`;
}

function fallbackConstraints(
  constraints: readonly CandidateConstraint[],
): string[] {
  return constraints.map(
    (constraint) => `${constraint.range} (${constraint.from})`,
  );
}

function rangeAdvisoriesFor(
  advisories: ReadonlyMap<string, readonly Advisory[]>,
  name: string,
  manifest: VersionManifest,
): readonly Advisory[] {
  return advisories.get(advisoryKey(name, manifest.version)) ?? [];
}

export async function selectCandidates(
  name: string,
  packument: Packument,
  constraints: readonly CandidateConstraint[],
  context: CandidateContext,
): Promise<CandidateOutcome> {
  const contractPassing: VersionManifest[] = [];
  const contractFailures: ContractViolation[] = [];
  const rangeSatisfying: VersionManifest[] = [];

  for (const manifest of Object.values(packument.versions)) {
    if (semver.valid(manifest.version) === null) {
      continue;
    }

    const violation = checkRuntimeContract(name, manifest, context.nodeVersion);

    if (violation !== undefined) {
      contractFailures.push(violation);
      continue;
    }

    contractPassing.push(manifest);

    let rangeSatisfied = true;

    for (const constraint of constraints) {
      if (!satisfies(manifest.version, constraint.range)) {
        rangeSatisfied = false;
        break;
      }
    }

    if (rangeSatisfied) {
      rangeSatisfying.push(manifest);
    }
  }

  if (contractPassing.length === 0) {
    if (contractFailures.length > 0) {
      return {
        kind: "failure",
        failure: { kind: "contract", message: contractMessage(contractFailures) },
      };
    }

    return {
      kind: "failure",
      failure: {
        kind: "resolution",
        message: conflictMessage(name, constraints, packument),
      },
    };
  }

  const rangeAdvisories = await context.queryAdvisories(
    rangeSatisfying.map((manifest) => ({ name, version: manifest.version })),
  );
  const cleanRange = rangeSatisfying.filter(
    (manifest) => rangeAdvisoriesFor(rangeAdvisories, name, manifest).length === 0,
  );

  if (cleanRange.length > 0) {
    cleanRange.sort((left, right) => semver.rcompare(left.version, right.version));
    preferLocked(cleanRange, context.preferred?.[name]);
    return { kind: "candidates", candidates: cleanRange };
  }

  const rangeVersions = new Set(
    rangeSatisfying.map((manifest) => manifest.version),
  );

  if (context.fallback === undefined) {
    if (rangeSatisfying.length > 0) {
      const affected: FallbackCandidate[] = [...rangeSatisfying]
        .sort((left, right) => semver.rcompare(left.version, right.version))
        .map((manifest) => ({
          version: manifest.version,
          advisories: rangeAdvisoriesFor(rangeAdvisories, name, manifest),
          satisfiesConstraints: true,
        }));

      return {
        kind: "failure",
        failure: {
          kind: "advisory",
          message: advisoryMessage(name, affected),
        },
      };
    }

    return {
      kind: "failure",
      failure: {
        kind: "resolution",
        message: conflictMessage(name, constraints, packument),
      },
    };
  }

  const remaining = contractPassing
    .filter((manifest) => !rangeVersions.has(manifest.version))
    .map((manifest) => ({ name, version: manifest.version }));
  const remainingAdvisories = await context.queryAdvisories(remaining);
  const allAdvisories = new Map<string, readonly Advisory[]>([
    ...rangeAdvisories,
    ...remainingAdvisories,
  ]);
  const fallbackCandidates: FallbackCandidate[] = [...contractPassing]
    .sort((left, right) => semver.rcompare(left.version, right.version))
    .map((manifest) => ({
      version: manifest.version,
      advisories: rangeAdvisoriesFor(allAdvisories, name, manifest),
      satisfiesConstraints: rangeVersions.has(manifest.version),
      ...(manifest.deprecated === undefined
        ? {}
        : { deprecated: manifest.deprecated }),
    }));

  const choice = await context.fallback({
    name,
    nodeVersion: context.nodeVersion,
    constraints: fallbackConstraints(constraints),
    candidates: fallbackCandidates,
    allowAdvisories: context.allowAdvisories,
  });

  if (choice === undefined) {
    return {
      kind: "failure",
      failure: {
        kind: rangeSatisfying.length > 0 ? "advisory" : "resolution",
        message: `fallback selection for ${name} was aborted`,
      },
    };
  }

  const reason = choice.reason.trim();

  if (reason.length === 0) {
    return {
      kind: "failure",
      failure: {
        kind: "resolution",
        message: `the override for ${name}@${choice.version} needs a reason`,
      },
    };
  }

  const chosen = contractPassing.find(
    (manifest) => manifest.version === choice.version,
  );

  if (chosen === undefined) {
    return {
      kind: "failure",
      failure: {
        kind: "resolution",
        message: `${name}@${choice.version} is not an available, contract-compatible version`,
      },
    };
  }

  const chosenAdvisories = rangeAdvisoriesFor(allAdvisories, name, chosen);

  if (chosenAdvisories.length > 0 && !context.allowAdvisories) {
    return {
      kind: "failure",
      failure: {
        kind: "advisory",
        message: `refusing ${name}@${chosen.version} because it has open advisories; pass --allow-advisories to accept it`,
      },
    };
  }

  const pin: OverridePin = {
    name,
    version: chosen.version,
    reason,
    createdAt: context.now().toISOString(),
    advisoryIds: chosenAdvisories.map((advisory) => advisory.id),
    constraints: fallbackConstraints(constraints),
  };

  return { kind: "override", manifest: chosen, pin };
}
