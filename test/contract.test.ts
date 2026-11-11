import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRuntimeContract } from "../src/resolve/contract.ts";
import { version } from "./helpers/registry.ts";

test("accepts a manifest whose engines range includes the running version", () => {
  const violation = checkRuntimeContract(
    "pkg",
    version("pkg", "1.0.0", { engines: { node: ">=22.12.0" } }),
    "24.14.1",
  );
  assert.equal(violation, undefined);
});

test("rejects a manifest without engines.node", () => {
  const violation = checkRuntimeContract(
    "pkg",
    version("pkg", "1.0.0", { engines: {} }),
    "24.14.1",
  );
  assert.equal(violation?.reason, "missing-engines");
});

test("rejects a manifest whose engines range excludes the running version", () => {
  const violation = checkRuntimeContract(
    "pkg",
    version("pkg", "1.0.0", { engines: { node: ">=99" } }),
    "24.14.1",
  );
  assert.equal(violation?.reason, "excluded-version");
  assert.equal(violation?.range, ">=99");
});

test("rejects an invalid engines range", () => {
  const violation = checkRuntimeContract(
    "pkg",
    version("pkg", "1.0.0", { engines: { node: "not a range" } }),
    "24.14.1",
  );
  assert.equal(violation?.reason, "invalid-range");
});
