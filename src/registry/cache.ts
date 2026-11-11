import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultCacheDir } from "../core/config.ts";
import type { Packument } from "./packument.ts";

export interface CacheEntry {
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  packument: Packument;
}

export class MetadataCache {
  readonly directory: string;

  constructor(directory: string = join(defaultCacheDir(), "metadata")) {
    this.directory = directory;
  }

  pathFor(name: string): string {
    return join(this.directory, `${encodeURIComponent(name)}.json`);
  }

  async read(name: string): Promise<CacheEntry | undefined> {
    let raw: string;

    try {
      raw = await readFile(this.pathFor(name), "utf8");
    } catch {
      return undefined;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    const entry = parsed as Partial<CacheEntry>;

    if (
      typeof entry.fetchedAt !== "number" ||
      typeof entry.packument !== "object" ||
      entry.packument === null
    ) {
      return undefined;
    }

    return {
      fetchedAt: entry.fetchedAt,
      packument: entry.packument as Packument,
      ...(typeof entry.etag === "string" ? { etag: entry.etag } : {}),
      ...(typeof entry.lastModified === "string"
        ? { lastModified: entry.lastModified }
        : {}),
    };
  }

  async write(name: string, entry: CacheEntry): Promise<void> {
    const target = this.pathFor(name);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { mode: 0o644 });
    await rename(temporary, target);
  }
}
