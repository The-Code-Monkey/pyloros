import semver from "../core/semver.ts";
import { UsageError } from "../core/errors.ts";
import type { FallbackSelector } from "../resolve/resolver.ts";

export interface Selection {
  name: string;
  version: string;
}

export function parseSelection(value: string): Selection {
  const separator = value.lastIndexOf("@");

  if (separator <= 0 || separator === value.length - 1) {
    throw new UsageError(
      `--select needs an exact name@version, received: ${value}`,
    );
  }

  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);

  if (semver.valid(version) === null) {
    throw new UsageError(`--select version is not exact: ${version}`);
  }

  return { name, version };
}

export function createSelectFallback(selection: string): FallbackSelector {
  const chosen = parseSelection(selection);

  return async (request) => {
    if (request.name !== chosen.name) {
      return undefined;
    }

    const candidate = request.candidates.find(
      (entry) => entry.version === chosen.version,
    );

    if (candidate === undefined) {
      return undefined;
    }

    return {
      version: candidate.version,
      reason: `selected ${chosen.name}@${chosen.version} via --select`,
    };
  };
}
