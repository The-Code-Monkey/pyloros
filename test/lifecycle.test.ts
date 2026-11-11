import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIFECYCLE_SCRIPTS,
  isLifecycleScript,
  lifecycleScripts,
} from "../src/gate/lifecycle.ts";

test("defines the canonical lifecycle script set in order", () => {
  assert.deepEqual([...LIFECYCLE_SCRIPTS], [
    "preinstall",
    "install",
    "postinstall",
  ]);
});

test("filters declared scripts to lifecycle scripts only", () => {
  assert.deepEqual(
    lifecycleScripts(["build", "postinstall", "test", "install", "preinstall"]),
    ["preinstall", "install", "postinstall"],
  );
});

test("classifies lifecycle names", () => {
  assert.equal(isLifecycleScript("install"), true);
  assert.equal(isLifecycleScript("build"), false);
});
