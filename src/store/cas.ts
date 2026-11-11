import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultCacheDir } from "../core/config.ts";
import { sha512Hex } from "../registry/integrity.ts";
import { extractTar } from "./tar.ts";

export interface CasEntry {
  digest: string;
  tarball: string;
  directory: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o644 });
  await rename(temporary, path);
}

export class ContentStore {
  readonly root: string;

  constructor(root: string = join(defaultCacheDir(), "store")) {
    this.root = root;
  }

  async putTarball(data: Uint8Array): Promise<CasEntry> {
    const digest = sha512Hex(data);
    const tarball = join(this.root, "tarballs", `${digest}.tgz`);
    const directory = join(this.root, "packages", digest);

    await mkdir(dirname(tarball), { recursive: true });

    if (!(await exists(tarball))) {
      await writeAtomic(tarball, data);
    }

    if (await exists(directory)) {
      return { digest, tarball, directory };
    }

    const entries = extractTar(data);
    const staging = join(this.root, `tmp-${process.pid}-${randomUUID()}`);

    try {
      await mkdir(staging, { recursive: true });

      for (const entry of entries) {
        const target = join(staging, ...entry.path.split("/"));

        if (entry.type === "dir") {
          await mkdir(target, { recursive: true, mode: 0o755 });
          continue;
        }

        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, entry.data, { mode: entry.mode, flag: "wx" });
      }

      await mkdir(dirname(directory), { recursive: true });

      try {
        await rename(staging, directory);
      } catch (error) {
        if (await exists(directory)) {
          await rm(staging, { recursive: true, force: true });
          return { digest, tarball, directory };
        }
        throw error;
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    return { digest, tarball, directory };
  }
}
