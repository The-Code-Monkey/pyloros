import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BubblewrapSandbox,
  bubblewrapArgs,
} from "../src/gate/sandbox.ts";
import type { SandboxRequest } from "../src/gate/types.ts";

async function environment(): Promise<{
  root: string;
  request: SandboxRequest;
  paths: { system: string; node: string; store: string; packageDir: string };
}> {
  const root = await mkdtemp(join(tmpdir(), "pyloros-sandbox-"));
  const system = join(root, "system");
  const node = join(root, "node");
  const store = join(root, "store");
  const packageDir = join(root, "package");

  await mkdir(system, { recursive: true });
  await mkdir(node, { recursive: true });
  await mkdir(store, { recursive: true });
  await mkdir(packageDir, { recursive: true });

  return {
    root,
    paths: { system, node, store, packageDir },
    request: {
      command: "sh",
      args: ["-c", "echo hi"],
      cwd: "/package",
      env: { PATH: "/bin" },
      writable: [{ source: packageDir, target: "/package" }],
      readOnly: [{ source: store, target: "/store" }],
      timeoutMs: 1000,
    },
  };
}

test("builds a no-network bubblewrap invocation", async () => {
  const { root, request, paths } = await environment();

  try {
    const args = bubblewrapArgs(request, {
      systemPaths: [paths.system, "/definitely/missing"],
      nodePrefix: paths.node,
    });
    const joined = args.join(" ");

    assert.ok(args.includes("--unshare-all"));
    assert.ok(args.includes("--clearenv"));
    assert.ok(args.includes("--die-with-parent"));
    assert.ok(args.includes("--new-session"));
    assert.ok(joined.includes(`--ro-bind ${paths.system} ${paths.system}`));
    assert.ok(joined.includes(`--ro-bind ${paths.node} ${paths.node}`));
    assert.ok(joined.includes(`--bind ${paths.packageDir} /package`));
    assert.ok(joined.includes(`--ro-bind ${paths.store} /store`));
    assert.ok(joined.includes("--chdir /package"));
    assert.ok(joined.includes("--setenv HOME /tmp"));
    assert.ok(joined.includes("--setenv PATH /bin"));
    assert.ok(!joined.includes("/definitely/missing"));
    assert.deepEqual(args.slice(-3), ["sh", "-c", "echo hi"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports unavailable when bubblewrap cannot be found", async () => {
  const sandbox = new BubblewrapSandbox({ binary: "/definitely/missing/bwrap" });
  assert.equal(await sandbox.available(), false);
});

test("reports available when the system bubblewrap responds", async (context) => {
  const sandbox = new BubblewrapSandbox();
  const available = await sandbox.available();

  if (!available) {
    context.skip("bubblewrap is not installed");
    return;
  }

  assert.equal(available, true);
});
