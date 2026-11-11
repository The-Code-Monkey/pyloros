export type Severity = "low" | "moderate" | "high" | "critical" | "unknown";

export type AdvisorySource = "osv" | "npm";

export interface Advisory {
  id: string;
  package: string;
  severity: Severity;
  url: string;
  summary?: string;
  aliases?: string[];
}

export interface AdvisoryQuery {
  name: string;
  version: string;
}

export interface AdvisorySnapshot {
  snapshotAt: string;
  sources: AdvisorySource[];
  entries: Record<string, Advisory[]>;
}

export interface AdvisoryBatch {
  entries: ReadonlyMap<string, readonly Advisory[]>;
  snapshot: AdvisorySnapshot;
}

export interface AdvisoryProvider {
  query(queries: readonly AdvisoryQuery[]): Promise<AdvisoryBatch>;
}

export function advisoryKey(name: string, version: string): string {
  return `${name}@${version}`;
}
