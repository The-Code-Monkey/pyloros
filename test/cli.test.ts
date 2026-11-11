import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("--help prints usage and exits 0", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pyloros/);
});

test("--version prints the version and exits 0", () => {
  const result = run("--version");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pyloros \d+\.\d+\.\d+/);
});

test("unknown command exits 2", () => {
  const result = run("wat");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command: wat/);
});
