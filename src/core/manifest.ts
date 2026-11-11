import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ManifestError } from "./errors.ts";
import semver from "./semver.ts";

export interface AllowScriptEntry {
  reason: string;
}

export interface PylorosPolicy {
  allowScripts: Record<string, AllowScriptEntry>;
  pins: Record<string, string>;
  allowAdvisories: string[];
}

export interface ProjectManifest {
  directory: string;
  name?: string;
  version?: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  engines?: { node?: string };
  policy: PylorosPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ManifestError(`${label} must be an object`);
  }

  const result: Record<string, string> = {};

  for (const [name, range] of Object.entries(value)) {
    if (name.length === 0) {
      throw new ManifestError(`${label} contains an empty package name`);
    }

    if (typeof range !== "string" || range.trim().length === 0) {
      throw new ManifestError(`${label}.${name} must be a non-empty string`);
    }

    result[name] = range;
  }

  return result;
}

function assertRegistryRanges(map: Record<string, string>, label: string): void {
  for (const [name, range] of Object.entries(map)) {
    if (/^(?:file|git|git\+|https?|ssh|npm|workspace):/u.test(range) || range.includes("://")) {
      throw new ManifestError(
        `${label}.${name} uses an unsupported specifier "${range}"; only registry semver ranges are allowed`,
      );
    }

    if (semver.validRange(range) === null) {
      throw new ManifestError(`${label}.${name} is not a valid semver range: "${range}"`);
    }
  }
}

function readPolicy(value: unknown): PylorosPolicy {
  if (value === undefined) {
    return { allowScripts: {}, pins: {}, allowAdvisories: [] };
  }

  if (!isRecord(value)) {
    throw new ManifestError("pyloros must be an object");
  }

  const allowScripts: Record<string, AllowScriptEntry> = {};
  const rawScripts = value["allowScripts"];

  if (rawScripts !== undefined) {
    if (!isRecord(rawScripts)) {
      throw new ManifestError("pyloros.allowScripts must be an object");
    }

    for (const [identity, entry] of Object.entries(rawScripts)) {
      if (!isRecord(entry) || typeof entry["reason"] !== "string" || entry["reason"].trim().length === 0) {
        throw new ManifestError(
          `pyloros.allowScripts.${identity} must be an object with a non-empty reason`,
        );
      }

      allowScripts[identity] = { reason: entry["reason"] };
    }
  }

  const pins: Record<string, string> = {};

  if (value["pins"] !== undefined) {
    const rawPins = value["pins"];

    if (!isRecord(rawPins)) {
      throw new ManifestError("pyloros.pins must be an object");
    }

    for (const [name, version] of Object.entries(rawPins)) {
      if (typeof version !== "string" || semver.valid(version) === null) {
        throw new ManifestError(`pyloros.pins.${name} must be an exact version`);
      }

      pins[name] = version;
    }
  }

  const allowAdvisories: string[] = [];

  if (value["allowAdvisories"] !== undefined) {
    if (!Array.isArray(value["allowAdvisories"])) {
      throw new ManifestError("pyloros.allowAdvisories must be an array");
    }

    for (const advisory of value["allowAdvisories"]) {
      if (typeof advisory !== "string" || advisory.trim().length === 0) {
        throw new ManifestError("pyloros.allowAdvisories must contain non-empty strings");
      }

      allowAdvisories.push(advisory);
    }
  }

  return { allowScripts, pins, allowAdvisories };
}

export function parseProjectManifest(directory: string, value: unknown): ProjectManifest {
  if (!isRecord(value)) {
    throw new ManifestError("package.json must contain a JSON object");
  }

  const dependencies = readStringMap(value["dependencies"], "dependencies");
  const optionalDependencies = readStringMap(
    value["optionalDependencies"],
    "optionalDependencies",
  );
  const peerDependencies = readStringMap(value["peerDependencies"], "peerDependencies");

  assertRegistryRanges(dependencies, "dependencies");
  assertRegistryRanges(optionalDependencies, "optionalDependencies");
  assertRegistryRanges(peerDependencies, "peerDependencies");

  let engines: { node?: string } | undefined;

  if (value["engines"] !== undefined) {
    if (!isRecord(value["engines"])) {
      throw new ManifestError("engines must be an object");
    }

    const node = value["engines"]["node"];

    if (node !== undefined && typeof node !== "string") {
      throw new ManifestError("engines.node must be a string");
    }

    engines = node === undefined ? {} : { node };
  }

  const name = value["name"];
  const version = value["version"];

  return {
    directory,
    dependencies,
    optionalDependencies,
    peerDependencies,
    policy: readPolicy(value["pyloros"]),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
    ...(engines === undefined ? {} : { engines }),
  };
}

export async function readProjectManifest(directory: string): Promise<ProjectManifest> {
  const file = join(directory, "package.json");
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new ManifestError(`cannot read ${file}`, { cause: error });
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ManifestError(`invalid JSON in ${file}`, { cause: error });
  }

  return parseProjectManifest(directory, value);
}
