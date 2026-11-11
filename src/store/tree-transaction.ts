import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

const STAGE_PREFIX = ".pyloros-stage-";
const PREVIOUS_PREFIX = ".pyloros-previous-";

export interface TreeTransaction {
  readonly staging: string;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function restoreNewestPrevious(projectDirectory: string): Promise<void> {
  if (await exists(join(projectDirectory, "node_modules"))) {
    return;
  }

  const candidates = (await readdir(projectDirectory))
    .filter((name) => name.startsWith(PREVIOUS_PREFIX))
    .map((name) => join(projectDirectory, name));

  if (candidates.length === 0) {
    return;
  }

  const ranked: { path: string; modified: number }[] = [];

  for (const path of candidates) {
    try {
      ranked.push({ path, modified: (await stat(path)).mtimeMs });
    } catch {
      continue;
    }
  }

  ranked.sort((left, right) => right.modified - left.modified);
  const newest = ranked[0];

  if (newest !== undefined) {
    await rename(newest.path, join(projectDirectory, "node_modules"));
  }
}

async function removeStaleStaging(projectDirectory: string): Promise<void> {
  for (const name of await readdir(projectDirectory)) {
    if (name.startsWith(STAGE_PREFIX)) {
      await rm(join(projectDirectory, name), { recursive: true, force: true });
    }
  }
}

export async function recoverTree(projectDirectory: string): Promise<void> {
  await restoreNewestPrevious(projectDirectory);
  await removeStaleStaging(projectDirectory);
}

export async function openTree(
  projectDirectory: string,
): Promise<TreeTransaction> {
  await recoverTree(projectDirectory);

  const staging = join(
    projectDirectory,
    `${STAGE_PREFIX}${process.pid}-${randomUUID()}`,
  );

  await mkdir(staging, { recursive: true });

  let finished = false;

  return {
    staging,
    async commit(): Promise<void> {
      if (finished) {
        return;
      }

      const target = join(projectDirectory, "node_modules");
      const previous = join(
        projectDirectory,
        `${PREVIOUS_PREFIX}${process.pid}-${randomUUID()}`,
      );
      let moved = false;

      try {
        if (await exists(target)) {
          await rename(target, previous);
          moved = true;
        }

        await rename(staging, target);
      } catch (error) {
        if (moved) {
          await rename(previous, target).catch(() => undefined);
        }

        throw error;
      }

      if (moved) {
        await rm(previous, { recursive: true, force: true });
      }

      finished = true;
    },
    async abort(): Promise<void> {
      if (finished) {
        return;
      }

      await rm(staging, { recursive: true, force: true });
      finished = true;
    },
  };
}
