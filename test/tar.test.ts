import assert from "node:assert/strict";
import { test } from "node:test";
import { TarError } from "../src/core/errors.ts";
import { extractTar } from "../src/store/tar.ts";
import { makeTar } from "./helpers/tar.ts";

test("extracts regular files and directories", () => {
  const entries = extractTar(
    makeTar([
      { name: "package/", type: "5" },
      { name: "package/index.js", data: "hello" },
    ]),
  );

  assert.deepEqual(
    entries.map((entry) => [entry.type, entry.path]),
    [
      ["dir", "package"],
      ["file", "package/index.js"],
    ],
  );

  const file = entries.find((entry) => entry.type === "file");
  assert.ok(file);
  assert.equal(new TextDecoder().decode(file.data), "hello");
});

test("accepts an uncompressed tar archive", () => {
  const entries = extractTar(
    makeTar([{ name: "package/index.js", data: "plain" }], { gzip: false }),
  );
  assert.equal(entries.length, 1);
});

test("rejects an absolute path", () => {
  assert.throws(
    () => extractTar(makeTar([{ name: "/etc/passwd", data: "x" }])),
    TarError,
  );
});

test("rejects a parent-directory escape", () => {
  assert.throws(
    () => extractTar(makeTar([{ name: "../evil.js", data: "x" }])),
    TarError,
  );
  assert.throws(
    () => extractTar(makeTar([{ name: "package/../../evil.js", data: "x" }])),
    TarError,
  );
});

test("rejects backslashes in paths", () => {
  assert.throws(
    () => extractTar(makeTar([{ name: "package\\evil.js", data: "x" }])),
    TarError,
  );
});

test("rejects symlinks and hardlinks", () => {
  assert.throws(
    () =>
      extractTar(
        makeTar([{ name: "package/link", data: "", type: "2", linkname: "/etc/passwd" }]),
      ),
    TarError,
  );
});

test("rejects duplicate entries", () => {
  assert.throws(
    () =>
      extractTar(
        makeTar([
          { name: "package/a.js", data: "one" },
          { name: "package/a.js", data: "two" },
        ]),
      ),
    TarError,
  );
});

test("rejects a corrupted checksum", () => {
  const archive = makeTar([{ name: "package/a.js", data: "x" }], { gzip: false });
  archive[0] = "P".charCodeAt(0);

  assert.throws(() => extractTar(archive), TarError);
});

test("rejects a truncated archive", () => {
  const archive = makeTar([{ name: "package/a.js", data: "long enough body" }], {
    gzip: false,
  });

  assert.throws(() => extractTar(archive.subarray(0, 520)), TarError);
});

test("rejects an empty archive", () => {
  assert.throws(() => extractTar(makeTar([])), TarError);
});
