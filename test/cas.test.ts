import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TarError } from "../src/core/errors.ts";
import { sha512Hex } from "../src/registry/integrity.ts";
import { ContentStore } from "../src/store/cas.ts";
import { makeTar } from "./helpers/tar.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyloros-cas-"));
}

test("stores a verified tarball and extracts its contents", async () => {
  const root = await tempRoot();
  const store = new ContentStore(join(root, "store"));
  const tarball = makeTar([
    { name: "package/", type: "5" },
    { name: "package/index.js", data: "hello" },
  ]);

  try {
    const entry = await store.putTarball(tarball);

    assert.equal(entry.digest, sha512Hex(tarball));
    assert.match(entry.digest, /^[0-9a-f]{128}$/u);
    assert.ok((await stat(entry.tarball)).isFile());

    const content = await readFile(join(entry.directory, "package/index.js"), "utf8");
    assert.equal(content, "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("is idempotent for the same content", async () => {
  const root = await tempRoot();
  const store = new ContentStore(join(root, "store"));
  const tarball = makeTar([{ name: "package/index.js", data: "hello" }]);

  try {
    const first = await store.putTarball(tarball);
    const second = await store.putTarball(tarball);

    assert.equal(first.directory, second.directory);
    assert.equal(first.digest, second.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to extract a traversing tarball", async () => {
  const root = await tempRoot();
  const store = new ContentStore(join(root, "store"));

  try {
    await assert.rejects(
      store.putTarball(makeTar([{ name: "../evil.js", data: "x" }])),
      TarError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
