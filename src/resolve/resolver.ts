import semver from "../core/semver.ts";
import {
  AdvisoryError,
  ResolutionError,
  RuntimeContractError,
} from "../core/errors.ts";
import type { ProjectManifest } from "../core/manifest.ts";
import type { Packument, VersionManifest } from "../registry/packument.ts";
import { mergeAdvisories } from "../advisories/normalize.ts";
import {
  advisoryKey,
  type Advisory,
  type AdvisoryProvider,
  type AdvisoryQuery,
  type AdvisorySnapshot,
  type AdvisorySource,
} from "../advisories/types.ts";
import {
  checkRuntimeContract,
  describeViolation,
  type ContractViolation,
} from "./contract.ts";

export interface PackumentProvider {
  getPackument(name: string): Promise<Packument>;
}

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

export interface ResolveOptions {
  nodeVersion?: string;
  maxSelections?: number;
  advisoryProvider?: AdvisoryProvider;
  fallback?: FallbackSelector;
  allowAdvisories?: boolean;
  now?: () => Date;
  preferred?: Readonly<Record<string, string>>;
}

type ConstraintKind = "root" | "dependency" | "peer" | "optional-peer";

interface Constraint {
  range: string;
  from: string;
  kind: ConstraintKind;
}

interface State {
  constraints: Map<string, Constraint[]>;
  soft: Map<string, Constraint[]>;
  selected: Map<string, VersionManifest>;
  overrides: Map<string, OverridePin>;
  steps: number;
}

interface Failure {
  kind: "resolution" | "contract" | "advisory";
  message: string;
}

type CandidateResult =
  | { ok: true; candidates: VersionManifest[] }
  | { ok: true; override: { manifest: VersionManifest; pin: OverridePin } }
  | { ok: false; failure: Failure };

type SolveResult =
  | { ok: true; state: State }
  | { ok: false; failure: Failure };

interface Context {
  nodeVersion: string;
  maxSelections: number;
  allowAdvisories: boolean;
  now: () => Date;
  preferred?: Readonly<Record<string, string>>;
  fallback?: FallbackSelector;
  getPackument(name: string): Promise<Packument>;
  queryAdvisories(
    queries: readonly AdvisoryQuery[],
  ): Promise<ReadonlyMap<string, readonly Advisory[]>>;
}

const DEFAULT_MAX_SELECTIONS = 10_000;

function currentNodeVersion(): string {
  return process.version.replace(/^v/u, "");
}

function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false });
  } catch {
    return false;
  }
}

function isValidRange(range: string): boolean {
  try {
    return semver.validRange(range) !== null;
  } catch {
    return false;
  }
}

function cloneState(state: State): State {
  const constraints = new Map<string, Constraint[]>();

  for (const [name, list] of state.constraints) {
    constraints.set(name, [...list]);
  }

  const soft = new Map<string, Constraint[]>();

  for (const [name, list] of state.soft) {
    soft.set(name, [...list]);
  }

  return {
    constraints,
    soft,
    selected: new Map(state.selected),
    overrides: new Map(state.overrides),
    steps: state.steps,
  };
}

function addConstraint(
  state: State,
  name: string,
  constraint: Constraint,
): Failure | undefined {
  let list = state.constraints.get(name);

  if (list === undefined) {
    list = [...(state.soft.get(name) ?? [])];
    state.constraints.set(name, list);
    state.soft.delete(name);
  }

  list.push(constraint);

  const selected = state.selected.get(name);

  if (
    selected !== undefined &&
    !state.overrides.has(name) &&
    !satisfies(selected.version, constraint.range)
  ) {
    return {
      kind: "resolution",
      message: `${name}@${selected.version} was selected, but ${constraint.from} requires ${constraint.range}`,
    };
  }

  return undefined;
}

function applyEdges(
  state: State,
  name: string,
  manifest: VersionManifest,
): Failure | undefined {
  const from = `${name}@${manifest.version}`;

  for (const table of [manifest.dependencies, manifest.optionalDependencies]) {
    for (const [dependency, range] of Object.entries(table ?? {})) {
      if (!isValidRange(range)) {
        return {
          kind: "resolution",
          message: `${from} declares an invalid range for ${dependency}: ${JSON.stringify(range)}`,
        };
      }

      const failure = addConstraint(state, dependency, {
        range,
        from,
        kind: "dependency",
      });

      if (failure !== undefined) {
        return failure;
      }
    }
  }

  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!isValidRange(range)) {
      return {
        kind: "resolution",
        message: `${from} declares an invalid peer range for ${peer}: ${JSON.stringify(range)}`,
      };
    }

    const optional = manifest.peerDependenciesMeta?.[peer]?.optional === true;
    const present = state.constraints.has(peer) || state.selected.has(peer);

    if (optional && !present) {
      const soft = state.soft.get(peer) ?? [];
      soft.push({ range, from, kind: "optional-peer" });
      state.soft.set(peer, soft);
      continue;
    }

    const failure = addConstraint(state, peer, { range, from, kind: "peer" });

    if (failure !== undefined) {
      return failure;
    }
  }

  return undefined;
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
  constraints: readonly Constraint[],
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

function fallbackConstraints(constraints: readonly Constraint[]): string[] {
  return constraints.map(
    (constraint) => `${constraint.range} (${constraint.from})`,
  );
}

async function candidatesFor(
  state: State,
  name: string,
  context: Context,
): Promise<CandidateResult> {
  const packument = await context.getPackument(name);
  const constraints = state.constraints.get(name) ?? [];
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
        ok: false,
        failure: { kind: "contract", message: contractMessage(contractFailures) },
      };
    }

    return {
      ok: false,
      failure: {
        kind: "resolution",
        message: conflictMessage(name, constraints, packument),
      },
    };
  }

  const rangeAdvisories = await context.queryAdvisories(
    rangeSatisfying.map((manifest) => ({ name, version: manifest.version })),
  );
  const rangeAdvisoriesFor = (manifest: VersionManifest): readonly Advisory[] =>
    rangeAdvisories.get(advisoryKey(name, manifest.version)) ?? [];

  const cleanRange = rangeSatisfying.filter(
    (manifest) => rangeAdvisoriesFor(manifest).length === 0,
  );

  if (cleanRange.length > 0) {
    cleanRange.sort((left, right) => semver.rcompare(left.version, right.version));
    preferLocked(cleanRange, context.preferred?.[name]);
    return { ok: true, candidates: cleanRange };
  }

  const rangeVersions = new Set(rangeSatisfying.map((manifest) => manifest.version));

  if (context.fallback === undefined) {
    if (rangeSatisfying.length > 0) {
      const affected: FallbackCandidate[] = [...rangeSatisfying]
        .sort((left, right) => semver.rcompare(left.version, right.version))
        .map((manifest) => ({
          version: manifest.version,
          advisories: rangeAdvisoriesFor(manifest),
          satisfiesConstraints: true,
        }));

      return {
        ok: false,
        failure: {
          kind: "advisory",
          message: advisoryMessage(name, affected),
        },
      };
    }

    return {
      ok: false,
      failure: {
        kind: "resolution",
        message: conflictMessage(name, constraints, packument),
      },
    };
  }

  const allAdvisories = await context.queryAdvisories(
    contractPassing.map((manifest) => ({ name, version: manifest.version })),
  );
  const advisoriesFor = (manifest: VersionManifest): readonly Advisory[] =>
    allAdvisories.get(advisoryKey(name, manifest.version)) ?? [];
  const fallbackCandidates: FallbackCandidate[] = [...contractPassing]
    .sort((left, right) => semver.rcompare(left.version, right.version))
    .map((manifest) => ({
      version: manifest.version,
      advisories: advisoriesFor(manifest),
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
      ok: false,
      failure: {
        kind: rangeSatisfying.length > 0 ? "advisory" : "resolution",
        message: `fallback selection for ${name} was aborted`,
      },
    };
  }

  const reason = choice.reason.trim();

  if (reason.length === 0) {
    return {
      ok: false,
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
      ok: false,
      failure: {
        kind: "resolution",
        message: `${name}@${choice.version} is not an available, contract-compatible version`,
      },
    };
  }

  const chosenAdvisories = advisoriesFor(chosen);

  if (chosenAdvisories.length > 0 && !context.allowAdvisories) {
    return {
      ok: false,
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

  return { ok: true, override: { manifest: chosen, pin } };
}

async function solve(state: State, context: Context): Promise<SolveResult> {
  if (state.steps > context.maxSelections) {
    return {
      ok: false,
      failure: {
        kind: "resolution",
        message: `resolution exceeded ${context.maxSelections} selections`,
      },
    };
  }

  const next = [...state.constraints.keys()]
    .filter((name) => !state.selected.has(name))
    .sort()[0];

  if (next === undefined) {
    return { ok: true, state };
  }

  const result = await candidatesFor(state, next, context);

  if (!result.ok) {
    return result;
  }

  if ("override" in result) {
    const branch = cloneState(state);
    branch.steps += 1;
    branch.selected.set(next, result.override.manifest);
    branch.overrides.set(next, result.override.pin);

    const edgeFailure = applyEdges(branch, next, result.override.manifest);

    if (edgeFailure !== undefined) {
      return { ok: false, failure: edgeFailure };
    }

    return solve(branch, context);
  }

  let firstFailure: Failure | undefined;

  for (const candidate of result.candidates) {
    const branch = cloneState(state);
    branch.steps += 1;
    branch.selected.set(next, candidate);

    const edgeFailure = applyEdges(branch, next, candidate);

    if (edgeFailure !== undefined) {
      firstFailure ??= edgeFailure;
      continue;
    }

    const solved = await solve(branch, context);

    if (solved.ok) {
      return solved;
    }

    firstFailure ??= solved.failure;
  }

  return {
    ok: false,
    failure:
      firstFailure ?? {
        kind: "resolution",
        message: `no version of ${next} could be selected`,
      },
  };
}

export async function resolve(
  manifest: ProjectManifest,
  registry: PackumentProvider,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const nodeVersion = options.nodeVersion ?? currentNodeVersion();
  const now = options.now ?? (() => new Date());
  const state: State = {
    constraints: new Map(),
    soft: new Map(),
    selected: new Map(),
    overrides: new Map(),
    steps: 0,
  };

  for (const table of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.devDependencies,
  ]) {
    for (const [name, range] of Object.entries(table)) {
      if (!isValidRange(range)) {
        throw new ResolutionError(
          `root dependency ${name} is not a valid semver range: ${JSON.stringify(range)}`,
        );
      }

      const failure = addConstraint(state, name, {
        range,
        from: "<root>",
        kind: "root",
      });

      if (failure !== undefined) {
        throw new ResolutionError(failure.message);
      }
    }
  }

  const packuments = new Map<string, Packument>();
  const advisoryCache = new Map<string, Advisory[]>();
  const sources = new Set<AdvisorySource>();
  let snapshotAt = now().toISOString();

  const context: Context = {
    nodeVersion,
    maxSelections: options.maxSelections ?? DEFAULT_MAX_SELECTIONS,
    allowAdvisories: options.allowAdvisories === true,
    now,
    ...(options.preferred === undefined ? {} : { preferred: options.preferred }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    async getPackument(name: string): Promise<Packument> {
      const cached = packuments.get(name);

      if (cached !== undefined) {
        return cached;
      }

      const packument = await registry.getPackument(name);
      packuments.set(name, packument);
      return packument;
    },
    async queryAdvisories(
      queries: readonly AdvisoryQuery[],
    ): Promise<ReadonlyMap<string, readonly Advisory[]>> {
      const result = new Map<string, readonly Advisory[]>();

      if (options.advisoryProvider === undefined) {
        for (const query of queries) {
          result.set(advisoryKey(query.name, query.version), []);
        }
        return result;
      }

      if (queries.length === 0) {
        return result;
      }

      const batch = await options.advisoryProvider.query(queries);
      snapshotAt = batch.snapshot.snapshotAt;

      for (const source of batch.snapshot.sources) {
        sources.add(source);
      }

      for (const query of queries) {
        const key = advisoryKey(query.name, query.version);
        const advisories = batch.entries.get(key) ?? [];
        advisoryCache.set(key, [...advisories]);
        result.set(key, advisories);
      }

      return result;
    },
  };

  const result = await solve(state, context);

  if (!result.ok) {
    switch (result.failure.kind) {
      case "contract":
        throw new RuntimeContractError(result.failure.message);
      case "advisory":
        throw new AdvisoryError(result.failure.message);
      case "resolution":
        throw new ResolutionError(result.failure.message);
    }
  }

  const packages = [...result.state.selected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, selected]) => ({
      name,
      version: selected.version,
      manifest: selected,
    }));

  const overrides = [...result.state.overrides.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const snapshotEntries = [...result.state.selected.entries()]
    .map(([name, manifest]) => {
      const key = advisoryKey(name, manifest.version);
      return [key, advisoryCache.get(key) ?? []] as const;
    })
    .filter(([, list]) => list.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  const advisories: AdvisorySnapshot = {
    snapshotAt,
    sources: [...sources].sort(),
    entries: Object.fromEntries(
      snapshotEntries.map(([key, list]) => [key, mergeAdvisories([list])]),
    ),
  };

  return { nodeVersion, packages, advisories, overrides };
}
