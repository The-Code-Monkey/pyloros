import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, canonicalize } from "../src/core/canonical-json.ts";

test("sorts object keys recursively", () => {
  const text = canonicalJson({ b: 1, a: { d: 2, c: 3 }, list: [{ y: 1, x: 2 }] });

  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'));
  assert.ok(text.indexOf('"c"') < text.indexOf('"d"'));
  assert.ok(text.indexOf('"x"') < text.indexOf('"y"'));
});

test("is stable and newline terminated", () => {
  const value = { z: [3, 2, 1], a: null };

  assert.equal(canonicalJson(value), canonicalJson(value));
  assert.ok(canonicalJson(value).endsWith("\n"));
});

test("drops undefined object members and nulls undefined array items", () => {
  assert.deepEqual(canonicalize({ keep: 1, drop: undefined }), { keep: 1 });
  assert.deepEqual(canonicalize([1, undefined, 2]), [1, null, 2]);
});
