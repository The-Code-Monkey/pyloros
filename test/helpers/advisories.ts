import {
  advisoryKey,
  type Advisory,
  type AdvisoryBatch,
  type AdvisoryProvider,
  type AdvisoryQuery,
} from "../../src/advisories/types.ts";

export const FIXED_SNAPSHOT = "2026-01-01T00:00:00.000Z";

export function advisory(id: string, extra: Partial<Advisory> = {}): Advisory {
  return {
    id,
    package: "pkg",
    severity: "high",
    url: `https://osv.dev/vulnerability/${id}`,
    ...extra,
  };
}

export class FakeAdvisories implements AdvisoryProvider {
  readonly #map: Record<string, Advisory[]>;

  constructor(map: Record<string, Advisory[]> = {}) {
    this.#map = map;
  }

  async query(queries: readonly AdvisoryQuery[]): Promise<AdvisoryBatch> {
    const entries = new Map<string, readonly Advisory[]>();
    const snapshotEntries: Record<string, Advisory[]> = {};

    for (const query of queries) {
      const key = advisoryKey(query.name, query.version);
      const list = this.#map[key] ?? [];
      entries.set(key, list);

      if (list.length > 0) {
        snapshotEntries[key] = list;
      }
    }

    return {
      entries,
      snapshot: {
        snapshotAt: FIXED_SNAPSHOT,
        sources: ["osv", "npm"],
        entries: snapshotEntries,
      },
    };
  }
}
