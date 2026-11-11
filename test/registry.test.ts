import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IntegrityError, RegistryError } from "../src/core/errors.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { sha512Sri } from "../src/registry/integrity.ts";
import type { VersionManifest } from "../src/registry/packument.ts";
import { makeTar } from "./helpers/tar.ts";

interface Fixture {
  server: Server;
  registry: string;
  packument: unknown;
  tarball: Uint8Array;
  manifest: VersionManifest;
  requests: () => { packument: number; conditional: number };
}

async function fixture(): Promise<Fixture> {
  const tarball = makeTar([{ name: "package/index.js", data: "console.log(1)" }]);
  const integrity = sha512Sri(tarball);
  const counters = { packument: 0, conditional: 0 };
  let packument: unknown;

  const server = createServer((request, response) => {
    if (request.url === "/fixture") {
      counters.packument += 1;

      if (request.headers["if-none-match"] === '"v1"') {
        counters.conditional += 1;
        response.writeHead(304);
        response.end();
        return;
      }

      response.writeHead(200, {
        "content-type": "application/json",
        etag: '"v1"',
      });
      response.end(JSON.stringify(packument));
      return;
    }

    if (request.url === "/fixture/-/fixture-1.0.0.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind to a port");
  }

  const registry = `http://127.0.0.1:${address.port}`;
  const tarballUrl = `${registry}/fixture/-/fixture-1.0.0.tgz`;
  const manifest: VersionManifest = {
    name: "fixture",
    version: "1.0.0",
    dist: { tarball: tarballUrl, integrity },
  };

  packument = {
    name: "fixture",
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": manifest },
  };

  return {
    server,
    registry,
    packument,
    tarball,
    manifest,
    requests: () => ({ ...counters }),
  };
}

test("fetches a packument, revalidates with ETag, and verifies a tarball", async () => {
  const data = await fixture();
  const cache = await mkdtemp(join(tmpdir(), "pyloros-registry-"));
  const client = new RegistryClient({
    registry: data.registry,
    cacheDir: cache,
    retries: 0,
  });

  try {
    const first = await client.getPackument("fixture");
    assert.equal(first.versions["1.0.0"]?.version, "1.0.0");
    assert.equal(data.requests().packument, 1);

    const second = await client.getPackument("fixture");
    assert.equal(second.versions["1.0.0"]?.version, "1.0.0");
    assert.equal(data.requests().packument, 2);
    assert.equal(data.requests().conditional, 1);

    const tarball = await client.getTarball(data.manifest);
    assert.deepEqual(tarball, data.tarball);
  } finally {
    data.server.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test("rejects a tarball whose bytes do not match the integrity", async () => {
  const data = await fixture();
  const cache = await mkdtemp(join(tmpdir(), "pyloros-registry-"));
  const client = new RegistryClient({
    registry: data.registry,
    cacheDir: cache,
    retries: 0,
  });
  const tampered: VersionManifest = {
    ...data.manifest,
    dist: {
      ...data.manifest.dist,
      integrity: sha512Sri(new TextEncoder().encode("other")),
    },
  };

  try {
    await assert.rejects(client.getTarball(tampered), IntegrityError);
  } finally {
    data.server.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test("rejects a tarball served from another origin", async () => {
  const data = await fixture();
  const cache = await mkdtemp(join(tmpdir(), "pyloros-registry-"));
  const client = new RegistryClient({
    registry: data.registry,
    cacheDir: cache,
    retries: 0,
  });
  const foreign: VersionManifest = {
    ...data.manifest,
    dist: { ...data.manifest.dist, tarball: "https://example.invalid/x.tgz" },
  };

  try {
    await assert.rejects(client.getTarball(foreign), RegistryError);
  } finally {
    data.server.close();
    await rm(cache, { recursive: true, force: true });
  }
});
