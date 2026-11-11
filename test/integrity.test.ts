import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IntegrityError } from "../src/core/errors.ts";
import {
  sha512Hex,
  sha512Sri,
  verifyIntegrity,
  verifyShasum,
} from "../src/registry/integrity.ts";

const data = new TextEncoder().encode("tarball bytes");

test("verifies a matching sha512 integrity value", () => {
  assert.doesNotThrow(() => {
    verifyIntegrity(data, sha512Sri(data));
  });
});

test("accepts one of several integrity tokens", () => {
  const wrong = sha512Sri(new TextEncoder().encode("other"));
  assert.doesNotThrow(() => {
    verifyIntegrity(data, `${wrong} ${sha512Sri(data)}`);
  });
});

test("rejects a mismatched integrity value", () => {
  const wrong = sha512Sri(new TextEncoder().encode("other"));
  assert.throws(() => {
    verifyIntegrity(data, wrong);
  }, IntegrityError);
});

test("rejects malformed integrity values", () => {
  assert.throws(() => {
    verifyIntegrity(data, "nonsense");
  }, IntegrityError);
  assert.throws(() => {
    verifyIntegrity(data, "md5-abc");
  }, IntegrityError);
});

test("verifies a matching sha1 shasum", () => {
  const shasum = createHash("sha1").update(data).digest("hex");
  assert.doesNotThrow(() => {
    verifyShasum(data, shasum);
  });
});

test("rejects a mismatched shasum", () => {
  assert.throws(() => {
    verifyShasum(data, "0".repeat(40));
  }, IntegrityError);
});

test("computes a stable sha512 hex digest", () => {
  assert.match(sha512Hex(data), /^[0-9a-f]{128}$/u);
  assert.equal(sha512Hex(data), sha512Hex(data));
});
