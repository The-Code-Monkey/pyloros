import type { Advisory, Severity } from "./types.ts";

const RANK: Record<Severity, number> = {
  unknown: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export function normalizeSeverity(value: unknown): Severity {
  if (typeof value !== "string") {
    return "unknown";
  }

  switch (value.trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "moderate";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}

function mergeOne(left: Advisory, right: Advisory): Advisory {
  const severity =
    RANK[left.severity] >= RANK[right.severity] ? left.severity : right.severity;
  const summary = left.summary ?? right.summary;
  const aliases =
    left.aliases === undefined && right.aliases === undefined
      ? undefined
      : [...new Set([...(left.aliases ?? []), ...(right.aliases ?? [])])];

  return {
    id: left.id,
    package: left.package.length > 0 ? left.package : right.package,
    severity,
    url: left.url.length > 0 ? left.url : right.url,
    ...(summary === undefined ? {} : { summary }),
    ...(aliases === undefined ? {} : { aliases }),
  };
}

export function mergeAdvisories(lists: readonly (readonly Advisory[])[]): Advisory[] {
  const byId = new Map<string, Advisory>();

  for (const list of lists) {
    for (const advisory of list) {
      const existing = byId.get(advisory.id);
      byId.set(
        advisory.id,
        existing === undefined ? advisory : mergeOne(existing, advisory),
      );
    }
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
