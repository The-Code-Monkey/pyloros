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
import { selectCandidates } from "./candidates.ts";
import type { CandidateFailure } from "./candidates.ts";
import type {
  FallbackSelector,
  OverridePin,
  Resolution,
  ResolvedPackage,
} from "./types.ts";

export type {
  FallbackCandidate,
  FallbackChoice,
  FallbackRequest,
  FallbackSelector,
  OverridePin,
  Resolution,
  ResolvedPackage,
} from "./types.ts";

export interface PackumentProvider {
  getPackument(name: string): Promise<Packument>;
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

type SolveResult =
  | { ok: true; state: State }
  | { ok: false; failure: CandidateFailure };

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
): CandidateFailure | undefined {
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
): CandidateFailure | undefined {
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

  const constraints = state.constraints.get(next) ?? [];
  const packument = await context.getPackument(next);
  const outcome = await selectCandidates(next, packument, constraints, {
    nodeVersion: context.nodeVersion,
    allowAdvisories: context.allowAdvisories,
    now: context.now,
    ...(context.preferred === undefined
      ? {}
      : { preferred: context.preferred }),
    ...(context.fallback === undefined ? {} : { fallback: context.fallback }),
    queryAdvisories: context.queryAdvisories,
  });

  if (outcome.kind === "failure") {
    return { ok: false, failure: outcome.failure };
  }

  if (outcome.kind === "override") {
    const branch = cloneState(state);
    branch.steps += 1;
    branch.selected.set(next, outcome.manifest);
    branch.overrides.set(next, outcome.pin);

    const edgeFailure = applyEdges(branch, next, outcome.manifest);

    if (edgeFailure !== undefined) {
      return { ok: false, failure: edgeFailure };
    }

    return solve(branch, context);
  }

  let firstFailure: CandidateFailure | undefined;

  for (const candidate of outcome.candidates) {
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
