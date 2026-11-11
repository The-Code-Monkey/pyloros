import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openTree,
  recoverTree,
} from "../src/store/tree-transaction.ts";

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyloros-tree-"));
}

test("commit replaces the previous tree and removes bookkeeping", async () => {
  const directory = await project();

  try {
    await mkdir(join(directory, "node_modules"), { recursive: true });
    await writeFile(join(directory, "node_modules", "old.txt"), "old");

    const tree = await openTree(directory);
    await writeFile(join(tree.staging, "new.txt"), "new");
    await tree.commit();
    await tree.abort();

    assert.equal(
      await readFile(join(directory, "node_modules", "new.txt"), "utf8"),
      "new",
    );
    await assert.rejects(
      readFile(join(directory, "node_modules", "old.txt")),
      /ENOENT/u,
    );

    const names = await readdir(directory);
    assert.equal(names.some((name) => name.startsWith(".pyloros-")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort removes staging and preserves the previous tree", async () => {
  const directory = await project();

  try {
    await mkdir(join(directory, "node_modules"), { recursive: true });
    await writeFile(join(directory, "node_modules", "old.txt"), "old");

    const tree = await openTree(directory);
    await writeFile(join(tree.staging, "new.txt"), "new");
    await tree.abort();

    assert.equal(
      await readFile(join(directory, "node_modules", "old.txt"), "utf8"),
      "old",
    );
    await assert.rejects(readFile(join(tree.staging, "new.txt")), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery restores the newest previous tree when the live tree is absent", async () => {
  const directory = await project();

  try {
    const older = join(directory, ".pyloros-previous-old");
    const newer = join(directory, ".pyloros-previous-new");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, "value.txt"), "old");
    await writeFile(join(newer, "value.txt"), "new");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    await recoverTree(directory);

    assert.equal(
      await readFile(join(directory, "node_modules", "value.txt"), "utf8"),
      "new",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery leaves a live tree alone and clears stale staging", async () => {
  const directory = await project();

  try {
    await mkdir(join(directory, "node_modules"), { recursive: true });
    await writeFile(join(directory, "node_modules", "live.txt"), "live");
    await mkdir(join(directory, ".pyloros-previous-old"), { recursive: true });
    await writeFile(
      join(directory, ".pyloros-previous-old", "value.txt"),
      "old",
    );
    await mkdir(join(directory, ".pyloros-stage-old"), { recursive: true });
    await writeFile(join(directory, ".pyloros-stage-old", "junk.txt"), "junk");

    await recoverTree(directory);

    assert.equal(
      await readFile(join(directory, "node_modules", "live.txt"), "utf8"),
      "live",
    );
    await assert.rejects(
      readFile(join(directory, "node_modules", "value.txt")),
      /ENOENT/u,
    );
    const names = await readdir(directory);
    assert.equal(names.some((name) => name.startsWith(".pyloros-stage-")), false);
    assert.equal(
      names.some((name) => name.startsWith(".pyloros-previous-")),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("openTree recovers before opening a staging directory", async () => {
  const directory = await project();

  try {
    await mkdir(join(directory, ".pyloros-previous-old"), { recursive: true });
    await writeFile(
      join(directory, ".pyloros-previous-old", "value.txt"),
      "previous",
    );

    const tree = await openTree(directory);

    assert.equal(
      await readFile(join(directory, "node_modules", "value.txt"), "utf8"),
      "previous",
    );
    await tree.abort();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
