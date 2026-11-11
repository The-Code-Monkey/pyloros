import { RegistryError } from "../core/errors.ts";
import { defaultCacheDir, defaultRegistry } from "../core/config.ts";
import { MetadataCache } from "./cache.ts";
import { verifyIntegrity, verifyShasum } from "./integrity.ts";
import { parsePackument, type Packument, type VersionManifest } from "./packument.ts";

const MAX_TARBALL_BYTES = 256 * 1024 * 1024;

export interface RegistryClientOptions {
  registry?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
}

function encodeName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("%2F");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class RegistryClient {
  readonly registry: string;
  readonly #cache: MetadataCache;
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #timeoutMs: number;

  constructor(options: RegistryClientOptions = {}) {
    this.registry = (options.registry ?? defaultRegistry()).replace(/\/+$/u, "");
    this.#cache = new MetadataCache(
      options.cacheDir === undefined
        ? undefined
        : `${options.cacheDir}/metadata`,
    );
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#retries = options.retries ?? 2;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getPackument(name: string): Promise<Packument> {
    const cached = await this.#cache.read(name);
    const headers = new Headers({
      accept: "application/vnd.npm.install-v1+json",
    });

    if (cached?.etag !== undefined) {
      headers.set("if-none-match", cached.etag);
    }

    if (cached?.lastModified !== undefined) {
      headers.set("if-modified-since", cached.lastModified);
    }

    const url = `${this.registry}/${encodeName(name)}`;
    const response = await this.#request(url, { headers });

    if (response.status === 304) {
      if (cached === undefined) {
        throw new RegistryError(`registry returned 304 for uncached package: ${name}`);
      }
      return cached.packument;
    }

    if (!response.ok) {
      throw new RegistryError(`registry responded ${response.status} for ${name}`);
    }

    const packument = parsePackument(name, (await response.json()) as unknown);
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    await this.#cache.write(name, {
      fetchedAt: Date.now(),
      packument,
      ...(etag === null ? {} : { etag }),
      ...(lastModified === null ? {} : { lastModified }),
    });

    return packument;
  }

  async getTarball(manifest: VersionManifest): Promise<Uint8Array> {
    if (!this.#sameOrigin(manifest.dist.tarball)) {
      throw new RegistryError(
        `tarball URL is not served by the configured registry: ${manifest.dist.tarball}`,
      );
    }

    const response = await this.#request(manifest.dist.tarball, {
      headers: new Headers({ accept: "application/octet-stream" }),
    });

    if (!response.ok) {
      throw new RegistryError(
        `registry responded ${response.status} for ${manifest.name}@${manifest.version}`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");

    if (declaredLength > MAX_TARBALL_BYTES) {
      throw new RegistryError(
        `tarball for ${manifest.name}@${manifest.version} exceeds the size limit`,
      );
    }

    const data = new Uint8Array(await response.arrayBuffer());

    if (data.byteLength > MAX_TARBALL_BYTES) {
      throw new RegistryError(
        `tarball for ${manifest.name}@${manifest.version} exceeds the size limit`,
      );
    }

    if (manifest.dist.integrity !== undefined) {
      verifyIntegrity(data, manifest.dist.integrity);
    } else if (manifest.dist.shasum !== undefined) {
      verifyShasum(data, manifest.dist.shasum);
    } else {
      throw new RegistryError(
        `registry published no integrity hash for ${manifest.name}@${manifest.version}`,
      );
    }

    return data;
  }

  #sameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.registry).origin;
    } catch {
      return false;
    }
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const attempts = this.#retries + 1;
    const fetchImpl = this.#fetch;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          if (attempt < attempts - 1) {
            await sleep(250 * 2 ** attempt);
            continue;
          }
        }

        return response;
      } catch (error) {
        lastError = error;

        if (attempt < attempts - 1) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
      }
    }

    throw new RegistryError(`request failed: ${url}`, { cause: lastError });
  }
}
