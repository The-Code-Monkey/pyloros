import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentPlatform,
  matchesPlatform,
} from "../src/store/platform.ts";

test("matches when no constraints are declared", () => {
  assert.equal(matchesPlatform({}, { os: "linux", cpu: "x64" }), true);
});

test("matches positive os and cpu lists", () => {
  assert.equal(
    matchesPlatform(
      { os: ["linux", "darwin"], cpu: ["x64", "arm64"] },
      { os: "linux", cpu: "x64" },
    ),
    true,
  );
});

test("honors negated entries", () => {
  assert.equal(
    matchesPlatform({ os: ["!win32"] }, { os: "linux", cpu: "x64" }),
    true,
  );
  assert.equal(
    matchesPlatform({ os: ["!linux"] }, { os: "linux", cpu: "x64" }),
    false,
  );
});

test("treats a wildcard as matching everything", () => {
  assert.equal(
    matchesPlatform({ os: ["*"], cpu: ["*"] }, { os: "linux", cpu: "arm64" }),
    true,
  );
});

test("fails closed when libc is constrained but unknown", () => {
  assert.equal(
    matchesPlatform({ libc: ["glibc"] }, { os: "linux", cpu: "x64" }),
    false,
  );
  assert.equal(
    matchesPlatform(
      { libc: ["glibc"] },
      { os: "linux", cpu: "x64", libc: "glibc" },
    ),
    true,
  );
  assert.equal(
    matchesPlatform({ libc: ["musl"] }, { os: "linux", cpu: "x64", libc: "glibc" }),
    false,
  );
});

test("derives the current platform from the process", () => {
  const platform = currentPlatform();
  assert.equal(platform.os, process.platform);
  assert.equal(platform.cpu, process.arch);
});
