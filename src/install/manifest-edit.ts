import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManifestError } from "../core/errors.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRawManifest(
  directory: string,
): Promise<Record<string, unknown>> {
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

  if (!isRecord(value)) {
    throw new ManifestError("package.json must contain a JSON object");
  }

  return value;
}

export async function writeRawManifest(
  directory: string,
  value: Record<string, unknown>,
): Promise<void> {
  const target = join(directory, "package.json");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o644,
  });
  await rename(temporary, target);
}

function table(
  manifest: Record<string, unknown>,
  key: "dependencies" | "optionalDependencies",
): Record<string, string> {
  const value = manifest[key];

  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ManifestError(`${key} must be an object`);
  }

  const result: Record<string, string> = {};

  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== "string") {
      throw new ManifestError(`${key}.${name} must be a string`);
    }
    result[name] = range;
  }

  return result;
}

export function setDependency(
  manifest: Record<string, unknown>,
  name: string,
  range: string,
): void {
  const dependencies = table(manifest, "dependencies");
  dependencies[name] = range;
  manifest["dependencies"] = dependencies;

  const optional = table(manifest, "optionalDependencies");
  delete optional[name];

  if (Object.keys(optional).length === 0 && manifest["optionalDependencies"] !== undefined) {
    manifest["optionalDependencies"] = optional;
  }
}

export function removeDependency(
  manifest: Record<string, unknown>,
  name: string,
): string | undefined {
  const dependencies = table(manifest, "dependencies");
  const optional = table(manifest, "optionalDependencies");
  const previous = dependencies[name] ?? optional[name];

  if (previous === undefined) {
    return undefined;
  }

  delete dependencies[name];
  delete optional[name];
  manifest["dependencies"] = dependencies;

  if (manifest["optionalDependencies"] !== undefined) {
    manifest["optionalDependencies"] = optional;
  }

  return previous;
}

export function dependencyRange(
  manifest: Record<string, unknown>,
  name: string,
): string | undefined {
  return table(manifest, "dependencies")[name] ?? table(manifest, "optionalDependencies")[name];
}
