import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdvisoryError } from "../core/errors.ts";
import { defaultCacheDir, defaultRegistry } from "../core/config.ts";
import { mergeAdvisories } from "./normalize.ts";
import { NpmAdvisoryClient } from "./npm.ts";
import { OsvClient } from "./osv.ts";
import {
  advisoryKey,
  type Advisory,
  type AdvisoryBatch,
  type AdvisoryProvider,
  type AdvisoryQuery,
  type AdvisorySnapshot,
  type AdvisorySource,
} from "./types.ts";

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  checkedAt: number;
  advisories: Advisory[];
  sources: AdvisorySource[];
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export interface AdvisoryServiceOptions {
  cacheDir?: string;
  ttlMs?: number;
  now?: () => number;
  osv?: OsvClient;
  npm?: NpmAdvisoryClient;
  fetchImpl?: typeof fetch;
  osvEndpoint?: string;
  registry?: string;
}

export class AdvisoryService implements AdvisoryProvider {
  readonly #cachePath: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #osv: OsvClient;
  readonly #npm: NpmAdvisoryClient;

  constructor(options: AdvisoryServiceOptions = {}) {
    const directory = options.cacheDir ?? defaultCacheDir();
    this.#cachePath = join(directory, "advisories.json");
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#osv =
      options.osv ??
      new OsvClient({
        ...(options.osvEndpoint === undefined ? {} : { endpoint: options.osvEndpoint }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    this.#npm =
      options.npm ??
      new NpmAdvisoryClient({
        ...(options.registry === undefined ? {} : { registry: options.registry }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
  }

  async query(queries: readonly AdvisoryQuery[]): Promise<AdvisoryBatch> {
    const unique = new Map<string, AdvisoryQuery>();

    for (const query of queries) {
      unique.set(advisoryKey(query.name, query.version), query);
    }

    const cache = await this.#readCache();
    const now = this.#now();
    const resolved = new Map<string, CacheEntry>();
    const stale: AdvisoryQuery[] = [];

    for (const [key, query] of unique) {
      const cached = cache.entries[key];

      if (cached !== undefined && now - cached.checkedAt < this.#ttlMs) {
        resolved.set(key, cached);
      } else {
        stale.push(query);
      }
    }

    if (stale.length > 0) {
      const [osv, npm] = await Promise.all([
        this.#osv.query(stale),
        this.#npm.query(stale),
      ]);

      for (const query of stale) {
        const key = advisoryKey(query.name, query.version);
        const advisories = mergeAdvisories([
          osv.get(key) ?? [],
          npm.get(key) ?? [],
        ]);
        const entry: CacheEntry = {
          checkedAt: now,
          advisories,
          sources: ["osv", "npm"],
        };
        cache.entries[key] = entry;
        resolved.set(key, entry);
      }

      await this.#writeCache(cache);
    }

    const entries = new Map<string, readonly Advisory[]>();
    const snapshotEntries: Record<string, Advisory[]> = {};
    const sources = new Set<AdvisorySource>();

    for (const key of unique.keys()) {
      const entry = resolved.get(key);

      if (entry === undefined) {
        entries.set(key, []);
        continue;
      }

      entries.set(key, entry.advisories);

      for (const source of entry.sources) {
        sources.add(source);
      }

      if (entry.advisories.length > 0) {
        snapshotEntries[key] = entry.advisories;
      }
    }

    const snapshot: AdvisorySnapshot = {
      snapshotAt: new Date(now).toISOString(),
      sources: [...sources].sort(),
      entries: snapshotEntries,
    };

    return { entries, snapshot };
  }

  async #readCache(): Promise<CacheFile> {
    let raw: string;

    try {
      raw = await readFile(this.#cachePath, "utf8");
    } catch {
      return { version: CACHE_VERSION, entries: {} };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return { version: CACHE_VERSION, entries: {} };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as CacheFile).version !== CACHE_VERSION ||
      typeof (parsed as CacheFile).entries !== "object" ||
      (parsed as CacheFile).entries === null
    ) {
      return { version: CACHE_VERSION, entries: {} };
    }

    return parsed as CacheFile;
  }

  async #writeCache(cache: CacheFile): Promise<void> {
    const temporary = `${this.#cachePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await mkdir(dirname(this.#cachePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o644 });
      await rename(temporary, this.#cachePath);
    } catch (error) {
      throw new AdvisoryError("could not write the advisory cache", { cause: error });
    }
  }
}

export function emptyAdvisorySnapshot(now: Date = new Date()): AdvisorySnapshot {
  return { snapshotAt: now.toISOString(), sources: [], entries: {} };
}

export function advisoryRegistry(): string {
  return defaultRegistry();
}
