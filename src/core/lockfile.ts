import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "./semver.ts";
import {
  IntegrityError,
  LockfileError,
} from "./errors.ts";
import { canonicalJson } from "./canonical-json.ts";
import { TOOL_NAME, TOOL_VERSION, currentNodeAbi } from "./tool.ts";
import { parseIntegrity } from "../registry/integrity.ts";
import type { ProjectManifest } from "./manifest.ts";
import type { Resolution, OverridePin } from "../resolve/resolver.ts";
import type {
  Advisory,
  AdvisorySnapshot,
  AdvisorySource,
  Severity,
} from "../advisories/types.ts";

export const LOCKFILE_NAME = "pyloros-lock.json";
export const LOCKFILE_VERSION = 1;

const SEVERITIES: readonly Severity[] = [
  "low",
  "moderate",
  "high",
  "critical",
  "unknown",
];

const SOURCES: readonly AdvisorySource[] = ["osv", "npm"];

export interface LockfileGate {
  allowedScripts: string[];
  reason: string;
}

export interface LockfileProvenance {
  status: "verified" | "absent";
  attestationDigest?: string;
  subjectIntegrity?: string;
  verifiedAt?: string;
}

export interface LockfilePackage {
  name: string;
  version: string;
  integrity: string;
  resolved: string;
  engines?: { node?: string };
  os?: string[];
  cpu?: string[];
  libc?: string[];
  peerDependencies?: Record<string, string>;
  deprecated?: string;
  scripts?: string[];
  scriptCommands?: Record<string, string>;
  gate?: LockfileGate;
  provenance?: LockfileProvenance;
}

export interface LockfileRoot {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion: number;
  tool: string;
  node: { version: string; abi: string };
  root: LockfileRoot;
  advisories: AdvisorySnapshot;
  packages: Record<string, LockfilePackage>;
  overrides: OverridePin[];
}

export interface CreateLockfileOptions {
  toolVersion?: string;
  nodeAbi?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new LockfileError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new LockfileError(`${label} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new LockfileError(`${label} must be an array of strings`);
  }

  return value as string[];
}

function stringMap(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requireRecord(value, label);
  const result: Record<string, string> = {};

  for (const [key, item] of Object.entries(record)) {
    result[key] = requireString(item, `${label}.${key}`);
  }

  return result;
}

function requiredStringMap(value: unknown, label: string): Record<string, string> {
  return stringMap(value, label) ?? {};
}

function shasumToIntegrity(shasum: string | undefined): string | undefined {
  if (shasum === undefined || !/^[0-9a-f]{40}$/iu.test(shasum)) {
    return undefined;
  }

  return `sha1-${Buffer.from(shasum, "hex").toString("base64")}`;
}

function normalizePackage(
  name: string,
  manifest: Resolution["packages"][number]["manifest"],
): LockfilePackage {
  const integrity =
    manifest.dist.integrity ?? shasumToIntegrity(manifest.dist.shasum);

  if (integrity === undefined) {
    throw new IntegrityError(
      `registry published no integrity hash for ${name}@${manifest.version}`,
    );
  }

  parseIntegrity(integrity);

  const scripts =
    manifest.scripts === undefined
      ? undefined
      : Object.keys(manifest.scripts).sort();
  const scriptCommands =
    manifest.scripts === undefined
      ? undefined
      : { ...manifest.scripts };
  const peers =
    manifest.peerDependencies === undefined
      ? undefined
      : { ...manifest.peerDependencies };
  const enginesNode = manifest.engines?.node;

  return {
    name,
    version: manifest.version,
    integrity,
    resolved: manifest.dist.tarball,
    ...(enginesNode === undefined ? {} : { engines: { node: enginesNode } }),
    ...(manifest.os === undefined ? {} : { os: [...manifest.os] }),
    ...(manifest.cpu === undefined ? {} : { cpu: [...manifest.cpu] }),
    ...(manifest.libc === undefined ? {} : { libc: [...manifest.libc] }),
    ...(peers === undefined || Object.keys(peers).length === 0
      ? {}
      : { peerDependencies: peers }),
    ...(manifest.deprecated === undefined ? {} : { deprecated: manifest.deprecated }),
    ...(scripts === undefined || scripts.length === 0 ? {} : { scripts }),
    ...(scriptCommands === undefined || Object.keys(scriptCommands).length === 0
      ? {}
      : { scriptCommands }),
  };
}

export function createLockfile(
  manifest: ProjectManifest,
  resolution: Resolution,
  options: CreateLockfileOptions = {},
): Lockfile {
  const packages: Record<string, LockfilePackage> = {};

  for (const pkg of resolution.packages) {
    packages[pkg.name] = normalizePackage(pkg.name, pkg.manifest);
  }

  return {
    lockfileVersion: LOCKFILE_VERSION,
    tool: `${TOOL_NAME}@${options.toolVersion ?? TOOL_VERSION}`,
    node: {
      version: resolution.nodeVersion,
      abi: options.nodeAbi ?? currentNodeAbi(),
    },
    root: {
      dependencies: { ...manifest.dependencies },
      optionalDependencies: { ...manifest.optionalDependencies },
    },
    advisories: resolution.advisories,
    packages,
    overrides: resolution.overrides,
  };
}

function parseAdvisory(value: unknown, label: string): Advisory {
  const record = requireRecord(value, label);
  const severity = requireString(record["severity"], `${label}.severity`);

  if (!SEVERITIES.includes(severity as Severity)) {
    throw new LockfileError(`${label}.severity is not valid: ${severity}`);
  }

  return {
    id: requireString(record["id"], `${label}.id`),
    package: requireString(record["package"], `${label}.package`),
    severity: severity as Severity,
    url: requireString(record["url"], `${label}.url`),
    ...(optionalString(record["summary"], `${label}.summary`) === undefined
      ? {}
      : { summary: record["summary"] as string }),
    ...(stringArray(record["aliases"], `${label}.aliases`) === undefined
      ? {}
      : { aliases: record["aliases"] as string[] }),
  };
}

function parseAdvisorySnapshot(value: unknown): AdvisorySnapshot {
  const record = requireRecord(value, "advisories");
  const sources = stringArray(record["sources"], "advisories.sources") ?? [];

  for (const source of sources) {
    if (!SOURCES.includes(source as AdvisorySource)) {
      throw new LockfileError(`advisories.sources contains an unknown source: ${source}`);
    }
  }

  const rawEntries = requireRecord(record["entries"], "advisories.entries");
  const entries: Record<string, Advisory[]> = {};

  for (const [key, list] of Object.entries(rawEntries)) {
    if (!Array.isArray(list)) {
      throw new LockfileError(`advisories.entries.${key} must be an array`);
    }

    entries[key] = list.map((item, index) =>
      parseAdvisory(item, `advisories.entries.${key}[${index}]`),
    );
  }

  return {
    snapshotAt: requireString(record["snapshotAt"], "advisories.snapshotAt"),
    sources: sources as AdvisorySource[],
    entries,
  };
}

function parsePackage(key: string, value: unknown): LockfilePackage {
  const record = requireRecord(value, `packages.${key}`);
  const name = requireString(record["name"], `packages.${key}.name`);

  if (name !== key) {
    throw new LockfileError(`packages.${key}.name must equal its key`);
  }

  const version = requireString(record["version"], `packages.${key}.version`);

  if (semver.valid(version) === null) {
    throw new LockfileError(`packages.${key}.version is not an exact version`);
  }

  const resolved = requireString(record["resolved"], `packages.${key}.resolved`);

  try {
    const url = new URL(resolved);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new LockfileError(`packages.${key}.resolved is not a valid URL`);
  }

  const enginesValue = record["engines"];
  let engines: { node?: string } | undefined;

  if (enginesValue !== undefined) {
    const enginesRecord = requireRecord(enginesValue, `packages.${key}.engines`);
    engines =
      enginesRecord["node"] === undefined
        ? {}
        : { node: requireString(enginesRecord["node"], `packages.${key}.engines.node`) };
  }

  return {
    name,
    version,
    integrity: requireString(record["integrity"], `packages.${key}.integrity`),
    resolved,
    ...(engines === undefined ? {} : { engines }),
    ...(stringArray(record["os"], `packages.${key}.os`) === undefined
      ? {}
      : { os: record["os"] as string[] }),
    ...(stringArray(record["cpu"], `packages.${key}.cpu`) === undefined
      ? {}
      : { cpu: record["cpu"] as string[] }),
    ...(stringArray(record["libc"], `packages.${key}.libc`) === undefined
      ? {}
      : { libc: record["libc"] as string[] }),
    ...(stringMap(record["peerDependencies"], `packages.${key}.peerDependencies`) ===
    undefined
      ? {}
      : {
          peerDependencies: record["peerDependencies"] as Record<string, string>,
        }),
    ...(optionalString(record["deprecated"], `packages.${key}.deprecated`) === undefined
      ? {}
      : { deprecated: record["deprecated"] as string }),
    ...(stringArray(record["scripts"], `packages.${key}.scripts`) === undefined
      ? {}
      : { scripts: record["scripts"] as string[] }),
    ...(stringMap(record["scriptCommands"], `packages.${key}.scriptCommands`) ===
    undefined
      ? {}
      : {
          scriptCommands: record["scriptCommands"] as Record<string, string>,
        }),
    ...(parseGate(record["gate"], key, record["scripts"]) === undefined
      ? {}
      : { gate: parseGate(record["gate"], key, record["scripts"]) as LockfileGate }),
    ...(parseProvenance(record["provenance"], key) === undefined
      ? {}
      : {
          provenance: parseProvenance(
            record["provenance"],
            key,
          ) as LockfileProvenance,
        }),
  };
}

function parseGate(
  value: unknown,
  key: string,
  rawScripts: unknown,
): LockfileGate | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requireRecord(value, `packages.${key}.gate`);
  const allowedScripts = stringArray(
    record["allowedScripts"],
    `packages.${key}.gate.allowedScripts`,
  );

  if (allowedScripts === undefined || allowedScripts.length === 0) {
    throw new LockfileError(`packages.${key}.gate.allowedScripts must be non-empty`);
  }

  const declared = Array.isArray(rawScripts)
    ? rawScripts.filter((item): item is string => typeof item === "string")
    : [];

  for (const script of allowedScripts) {
    if (!declared.includes(script)) {
      throw new LockfileError(
        `packages.${key}.gate allows an undeclared script: ${script}`,
      );
    }
  }

  const reason = requireString(record["reason"], `packages.${key}.gate.reason`);

  if (reason.trim().length === 0) {
    throw new LockfileError(`packages.${key}.gate.reason must not be empty`);
  }

  return { allowedScripts, reason };
}

function parseProvenance(
  value: unknown,
  key: string,
): LockfileProvenance | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requireRecord(value, `packages.${key}.provenance`);
  const status = requireString(
    record["status"],
    `packages.${key}.provenance.status`,
  );

  if (status !== "verified" && status !== "absent") {
    throw new LockfileError(
      `packages.${key}.provenance.status must be verified or absent`,
    );
  }

  const attestationDigest = optionalString(
    record["attestationDigest"],
    `packages.${key}.provenance.attestationDigest`,
  );
  const subjectIntegrity = optionalString(
    record["subjectIntegrity"],
    `packages.${key}.provenance.subjectIntegrity`,
  );
  const verifiedAt = optionalString(
    record["verifiedAt"],
    `packages.${key}.provenance.verifiedAt`,
  );

  if (
    status === "verified" &&
    (attestationDigest === undefined ||
      subjectIntegrity === undefined ||
      verifiedAt === undefined)
  ) {
    throw new LockfileError(
      `packages.${key}.provenance verified entries need digest, subject, and timestamp`,
    );
  }

  return {
    status,
    ...(attestationDigest === undefined ? {} : { attestationDigest }),
    ...(subjectIntegrity === undefined ? {} : { subjectIntegrity }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
  };
}

function parseOverride(value: unknown, label: string): OverridePin {
  const record = requireRecord(value, label);

  return {
    name: requireString(record["name"], `${label}.name`),
    version: requireString(record["version"], `${label}.version`),
    reason: requireString(record["reason"], `${label}.reason`),
    createdAt: requireString(record["createdAt"], `${label}.createdAt`),
    advisoryIds: stringArray(record["advisoryIds"], `${label}.advisoryIds`) ?? [],
    constraints: stringArray(record["constraints"], `${label}.constraints`) ?? [],
  };
}

export function parseLockfile(value: unknown): Lockfile {
  const record = requireRecord(value, "lockfile");

  if (record["lockfileVersion"] !== LOCKFILE_VERSION) {
    throw new LockfileError(
      `unsupported lockfileVersion: ${String(record["lockfileVersion"])}`,
    );
  }

  const node = requireRecord(record["node"], "node");
  const root = requireRecord(record["root"], "root");
  const rawPackages = requireRecord(record["packages"], "packages");
  const rawOverrides = record["overrides"];

  if (!Array.isArray(rawOverrides)) {
    throw new LockfileError("overrides must be an array");
  }

  const packages: Record<string, LockfilePackage> = {};

  for (const [key, item] of Object.entries(rawPackages)) {
    packages[key] = parsePackage(key, item);
  }

  return {
    lockfileVersion: LOCKFILE_VERSION,
    tool: requireString(record["tool"], "tool"),
    node: {
      version: requireString(node["version"], "node.version"),
      abi: requireString(node["abi"], "node.abi"),
    },
    root: {
      dependencies: requiredStringMap(root["dependencies"], "root.dependencies"),
      optionalDependencies: requiredStringMap(
        root["optionalDependencies"],
        "root.optionalDependencies",
      ),
    },
    advisories: parseAdvisorySnapshot(record["advisories"]),
    packages,
    overrides: rawOverrides.map((item, index) =>
      parseOverride(item, `overrides[${index}]`),
    ),
  };
}

export async function readLockfile(directory: string): Promise<Lockfile | undefined> {
  const file = join(directory, LOCKFILE_NAME);
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new LockfileError(`cannot read ${file}`, { cause: error });
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new LockfileError(`invalid JSON in ${file}`, { cause: error });
  }

  return parseLockfile(value);
}

export function serializeLockfile(lockfile: Lockfile): string {
  return canonicalJson(lockfile);
}

export async function writeLockfile(
  directory: string,
  lockfile: Lockfile,
): Promise<string> {
  const target = join(directory, LOCKFILE_NAME);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(directory, { recursive: true });
  await writeFile(temporary, serializeLockfile(lockfile), { mode: 0o644 });
  await rename(temporary, target);

  return target;
}
