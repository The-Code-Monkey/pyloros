import { homedir } from "node:os";
import { join } from "node:path";

export function defaultCacheDir(): string {
  return process.env.PYLOROS_CACHE_DIR ?? join(homedir(), ".cache", "pyloros");
}

export function defaultRegistry(): string {
  return process.env.PYLOROS_REGISTRY ?? "https://registry.npmjs.org";
}

export function defaultOsvEndpoint(): string {
  return process.env.PYLOROS_OSV_URL ?? "https://api.osv.dev";
}
