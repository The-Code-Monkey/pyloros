import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sha512Sri } from "../src/registry/integrity.ts";
import { makeTar } from "./helpers/tar.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Fixture {
  registry: string;
  server: Server;
  tarballs: Map<string, Uint8Array>;
}

async function fixture(): Promise<Fixture> {
  const tarballs = new Map<string, Uint8Array>([
    ["alpha", makeTar([{ name: "package/index.js", data: "alpha" }])],
    ["beta", makeTar([{ name: "package/index.js", data: "beta" }])],
  ]);
  const versions: Record<string, string> = { alpha: "1.0.0", beta: "2.0.0" };
  let registry = "";

  const packument = (name: string) => {
    const data = tarballs.get(name) as Uint8Array;
    const version = versions[name] as string;

    return {
      name,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          name,
          version,
          engines: { node: ">=18" },
          dist: {
            tarball: `${registry}/${name}/-/${name}-${version}.tgz`,
            integrity: sha512Sri(data),
          },
        },
      },
    };
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";

      if (request.method === "GET" && (path === "/alpha" || path === "/beta")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(packument(path.slice(1))));
        return;
      }

      const tarballMatch = /^\/(alpha|beta)\/-\/(?:alpha|beta)-[\d.]+\.tgz$/u.exec(
        path,
      );

      if (request.method === "GET" && tarballMatch !== null) {
        const data = tarballs.get(tarballMatch[1] as string) as Uint8Array;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from(data));
        return;
      }

      if (request.method === "POST" && path === "/osv/v1/querybatch") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          queries: unknown[];
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            results: body.queries.map(() => ({ vulns: [] })),
          }),
        );
        return;
      }

      if (
        request.method === "POST" &&
        path === "/-/npm/v1/security/advisories/bulk"
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }

      if (path.startsWith("/-/npm/v1/attestations/")) {
        response.writeHead(404);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind");
  }

  registry = `http://127.0.0.1:${address.port}`;

  return { registry, server, tarballs };
}

function run(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function lastJson(value: string): Record<string, unknown> {
  const lines = value.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

test("commands compose install, add, remove, update, audit, why, and check", async () => {
  const data = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "pyloros-commands-"));
  const env = {
    ...process.env,
    PYLOROS_REGISTRY: data.registry,
    PYLOROS_OSV_URL: `${data.registry}/osv`,
    PYLOROS_CACHE_DIR: join(directory, "cache"),
  };

  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          dependencies: { alpha: "1.0.0" },
          pyloros: { allowScripts: {}, pins: {}, allowAdvisories: [] },
        },
        null,
        2,
      )}\n`,
    );

    const installed = await run(directory, env, "install", "--json");
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const installJson = lastJson(installed.stdout);
    assert.equal(installJson["ok"], true);
    assert.equal(installJson["mode"], "resolve");
    assert.equal(installJson["wroteLockfile"], true);
    assert.equal(
      await readFile(join(directory, "node_modules", "alpha", "index.js"), "utf8"),
      "alpha",
    );

    const frozen = await run(directory, env, "install", "--json");
    assert.equal(frozen.status, 0, frozen.stderr);
    assert.equal(lastJson(frozen.stdout)["mode"], "frozen");

    const added = await run(directory, env, "add", "beta", "--json");
    assert.equal(added.status, 0, added.stderr);
    assert.equal(lastJson(added.stdout)["version"], "2.0.0");

    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.equal(manifest.dependencies["beta"], "2.0.0");

    const audit = await run(directory, env, "audit", "--json");
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(lastJson(audit.stdout)["ok"], true);

    const why = await run(directory, env, "why", "beta", "--json");
    assert.equal(why.status, 0, why.stderr);
    assert.equal(lastJson(why.stdout)["version"], "2.0.0");

    const checked = await run(directory, env, "check", "--json");
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(lastJson(checked.stdout)["ok"], true);

    const updated = await run(directory, env, "update", "--json");
    assert.equal(updated.status, 0, updated.stderr);

    const removed = await run(directory, env, "remove", "alpha", "--json");
    assert.equal(removed.status, 0, removed.stderr);
    const afterRemove = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.equal(afterRemove.dependencies["alpha"], undefined);
    assert.equal(afterRemove.dependencies["beta"], "2.0.0");

    const missing = await run(directory, env, "why", "alpha", "--json");
    assert.equal(missing.status, 2);
    assert.equal(lastJson(missing.stdout)["ok"], false);
    assert.equal(lastJson(missing.stdout)["exitCode"], 2);

    const driftManifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    driftManifest.dependencies["gamma"] = "1.0.0";
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          dependencies: driftManifest.dependencies,
          pyloros: { allowScripts: {}, pins: {}, allowAdvisories: [] },
        },
        null,
        2,
      )}\n`,
    );

    const drift = await run(directory, env, "check", "--json");
    assert.equal(drift.status, 7);
    assert.equal(lastJson(drift.stdout)["exitCode"], 7);
  } finally {
    data.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("init creates a manifest once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pyloros-init-"));

  try {
    const first = await run(directory, process.env, "init", "--json");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(lastJson(first.stdout)["ok"], true);

    const created = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { pyloros: unknown };
    assert.ok(created.pyloros);

    const second = await run(directory, process.env, "init", "--json");
    assert.equal(second.status, 2);
    assert.equal(lastJson(second.stdout)["ok"], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
