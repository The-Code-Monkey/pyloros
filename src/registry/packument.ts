export interface Dist {
  tarball: string;
  integrity?: string;
  shasum?: string;
}

export interface VersionManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: { node?: string };
  os?: string[];
  cpu?: string[];
  libc?: string[];
  scripts?: Record<string, string>;
  hasInstallScript?: boolean;
  deprecated?: string;
  dist: Dist;
}

export interface Packument {
  name: string;
  versions: Record<string, VersionManifest>;
  "dist-tags"?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`invalid packument: ${label} must be a non-empty string`);
  }
  return value;
}

function requireDist(value: unknown, label: string): Dist {
  if (!isRecord(value)) {
    throw new TypeError(`invalid packument: ${label}.dist must be an object`);
  }

  const tarball = requireString(value["tarball"], `${label}.dist.tarball`);
  const integrity = value["integrity"];
  const shasum = value["shasum"];

  if (integrity !== undefined && typeof integrity !== "string") {
    throw new TypeError(`invalid packument: ${label}.dist.integrity must be a string`);
  }

  if (shasum !== undefined && typeof shasum !== "string") {
    throw new TypeError(`invalid packument: ${label}.dist.shasum must be a string`);
  }

  return {
    tarball,
    ...(integrity === undefined ? {} : { integrity }),
    ...(shasum === undefined ? {} : { shasum }),
  };
}

export function parsePackument(name: string, value: unknown): Packument {
  if (!isRecord(value)) {
    throw new TypeError("invalid packument: response is not an object");
  }

  const versions = value["versions"];

  if (!isRecord(versions)) {
    throw new TypeError("invalid packument: versions is not an object");
  }

  for (const [version, manifest] of Object.entries(versions)) {
    if (!isRecord(manifest)) {
      throw new TypeError(`invalid packument: version ${version} is not an object`);
    }

    requireString(manifest["version"], `versions[${version}].version`);
    requireDist(manifest["dist"], `versions[${version}]`);
  }

  const rawTags = value["dist-tags"];
  const tags = isRecord(rawTags)
    ? Object.fromEntries(
        Object.entries(rawTags).filter((entry): entry is [string, string] => {
          return typeof entry[1] === "string";
        }),
      )
    : undefined;

  return {
    name,
    versions: versions as unknown as Record<string, VersionManifest>,
    ...(tags === undefined ? {} : { "dist-tags": tags }),
  };
}
