import { AdvisoryError } from "../core/errors.ts";
import { defaultOsvEndpoint } from "../core/config.ts";
import { mergeAdvisories, normalizeSeverity } from "./normalize.ts";
import {
  advisoryKey,
  type Advisory,
  type AdvisoryQuery,
} from "./types.ts";

const CHUNK_SIZE = 1000;

export interface OsvClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OsvClient {
  readonly endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: OsvClientOptions = {}) {
    this.endpoint = (options.endpoint ?? defaultOsvEndpoint()).replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async query(queries: readonly AdvisoryQuery[]): Promise<Map<string, Advisory[]>> {
    const result = new Map<string, Advisory[]>();

    for (const query of queries) {
      result.set(advisoryKey(query.name, query.version), []);
    }

    for (let start = 0; start < queries.length; start += CHUNK_SIZE) {
      const chunk = queries.slice(start, start + CHUNK_SIZE);
      const results = await this.#request(chunk);

      chunk.forEach((query, index) => {
        const vulnerabilities = results[index] ?? [];
        const advisories: Advisory[] = [];

        for (const vulnerability of vulnerabilities) {
          const id = vulnerability["id"];

          if (typeof id !== "string" || id.length === 0) {
            continue;
          }

          const database = isRecord(vulnerability["database_specific"])
            ? vulnerability["database_specific"]
            : {};
          const summary = vulnerability["summary"];
          const aliases = Array.isArray(vulnerability["aliases"])
            ? vulnerability["aliases"].filter(
                (alias): alias is string => typeof alias === "string",
              )
            : [];

          advisories.push({
            id,
            package: query.name,
            severity: normalizeSeverity(database["severity"]),
            url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
            ...(typeof summary === "string" ? { summary } : {}),
            ...(aliases.length === 0 ? {} : { aliases }),
          });
        }

        result.set(
          advisoryKey(query.name, query.version),
          mergeAdvisories([advisories]),
        );
      });
    }

    return result;
  }

  async #request(chunk: readonly AdvisoryQuery[]): Promise<Record<string, unknown>[][]> {
    const body = {
      queries: chunk.map((query) => ({
        version: query.version,
        package: { name: query.name, ecosystem: "npm" },
      })),
    };

    let response: Response;

    try {
      const fetchImpl = this.#fetch;
      response = await fetchImpl(`${this.endpoint}/v1/querybatch`, {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new AdvisoryError("OSV advisory query failed", { cause: error });
    }

    if (!response.ok) {
      throw new AdvisoryError(`OSV advisory query failed with status ${response.status}`);
    }

    const payload = (await response.json()) as unknown;

    if (!isRecord(payload) || !Array.isArray(payload["results"])) {
      throw new AdvisoryError("OSV advisory query returned an unexpected response");
    }

    if (payload["results"].length !== chunk.length) {
      throw new AdvisoryError("OSV advisory query returned a mismatched result count");
    }

    return payload["results"].map((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      const vulns = entry["vulns"];

      if (!Array.isArray(vulns)) {
        return [];
      }

      return vulns.filter(isRecord);
    });
  }
}
