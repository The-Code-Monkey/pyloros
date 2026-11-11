import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/real-world", import.meta.url));
const enabled = process.env.PYLOROS_NETWORK === "1";

function run(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test(
  "installs and runs the real-world fixture against npm",
  { skip: enabled ? false : "set PYLOROS_NETWORK=1 to run" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pyloros-e2e-"));
    const env = {
      ...process.env,
      PYLOROS_CACHE_DIR: join(directory, "cache"),
    };

    try {
      await cp(fixture, directory, {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      });

      const installed = run(directory, env, "install", "--json");
      assert.equal(installed.status, 0, installed.stderr || installed.stdout);

      const result = JSON.parse(installed.stdout.trim()) as {
        ok: boolean;
        mode: string;
        installed: string[];
      };
      assert.equal(result.ok, true);
      assert.equal(result.mode, "resolve");
      assert.deepEqual(result.installed, ["commander", "kleur", "semver"]);

      const lockfile = await readFile(
        join(directory, "pyloros-lock.json"),
        "utf8",
      );
      assert.match(lockfile, /"commander"/u);

      const app = spawnSync(process.execPath, ["src/index.js", "1.2.3"], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.equal(app.status, 0, app.stderr);
      assert.equal(app.stdout.trim(), "1.2.3");

      const frozen = run(directory, env, "install", "--json");
      assert.equal(frozen.status, 0, frozen.stderr);

      const checked = run(directory, env, "check", "--json");
      assert.equal(checked.status, 0, checked.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
