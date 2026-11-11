import semver from "../core/semver.ts";
import { RegistryError } from "../core/errors.ts";
import { defaultRegistry } from "../core/config.ts";
import { mergeAdvisories, normalizeSeverity } from "./normalize.ts";
import {
  advisoryKey,
  type Advisory,
  type AdvisoryQuery,
  type Severity,
} from "./types.ts";

export interface NpmAdvisoryClientOptions {
  registry?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function affects(version: string, vulnerableVersions: string): boolean {
  try {
    if (semver.validRange(vulnerableVersions) === null) {
      return true;
    }

    return semver.satisfies(version, vulnerableVersions, { includePrerelease: true });
  } catch {
    return true;
  }
}

function severityOf(value: unknown): Severity {
  return normalizeSeverity(value);
}

export class NpmAdvisoryClient {
  readonly registry: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: NpmAdvisoryClientOptions = {}) {
    this.registry = (options.registry ?? defaultRegistry()).replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async query(queries: readonly AdvisoryQuery[]): Promise<Map<string, Advisory[]>> {
    const result = new Map<string, Advisory[]>();
    const versionsByName = new Map<string, Set<string>>();

    for (const query of queries) {
      result.set(advisoryKey(query.name, query.version), []);
      const versions = versionsByName.get(query.name) ?? new Set<string>();
      versions.add(query.version);
      versionsByName.set(query.name, versions);
    }

    if (versionsByName.size === 0) {
      return result;
    }

    const payload = Object.fromEntries(
      [...versionsByName.entries()].map(([name, versions]) => [name, [...versions]]),
    );
    const advisoriesByName = await this.#request(payload);

    for (const [name, versions] of versionsByName) {
      const advisories = advisoriesByName.get(name) ?? [];

      for (const version of versions) {
        const matching: Advisory[] = [];

        for (const advisory of advisories) {
          const vulnerable = advisory["vulnerable_versions"];

          if (typeof vulnerable !== "string") {
            continue;
          }

          if (!affects(version, vulnerable)) {
            continue;
          }

          const rawId = advisory["id"];
          const id =
            typeof rawId === "number"
              ? String(rawId)
              : typeof rawId === "string" && rawId.length > 0
                ? rawId
                : undefined;

          if (id === undefined) {
            continue;
          }

          const url = advisory["url"];
          const summary = advisory["title"];

          matching.push({
            id,
            package: name,
            severity: severityOf(advisory["severity"]),
            url:
              typeof url === "string" && url.length > 0
                ? url
                : `https://www.npmjs.com/advisories/${encodeURIComponent(id)}`,
            ...(typeof summary === "string" ? { summary } : {}),
          });
        }

        result.set(advisoryKey(name, version), mergeAdvisories([matching]));
      }
    }

    return result;
  }

  async #request(payload: Record<string, string[]>): Promise<Map<string, Record<string, unknown>[]>> {
    let response: Response;

    try {
      const fetchImpl = this.#fetch;
      response = await fetchImpl(
        `${this.registry}/-/npm/v1/security/advisories/bulk`,
        {
          method: "POST",
          headers: new Headers({ "content-type": "application/json" }),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      throw new RegistryError("npm advisory query failed", { cause: error });
    }

    if (!response.ok) {
      throw new RegistryError(
        `npm advisory query failed with status ${response.status}`,
      );
    }

    const body = (await response.json()) as unknown;

    if (!isRecord(body)) {
      throw new RegistryError("npm advisory query returned an unexpected response");
    }

    const result = new Map<string, Record<string, unknown>[]>();

    for (const [name, value] of Object.entries(body)) {
      if (!Array.isArray(value)) {
        continue;
      }

      result.set(name, value.filter(isRecord));
    }

    return result;
  }
}
