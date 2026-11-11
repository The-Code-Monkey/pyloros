import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdvisoryError } from "../src/core/errors.ts";
import { AdvisoryService } from "../src/advisories/service.ts";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const OSV_VULN = {
  id: "GHSA-1",
  summary: "prototype pollution",
  database_specific: { severity: "HIGH" },
};
const NPM_ADVISORY = {
  id: 2,
  url: "https://npm.example/advisories/2",
  title: "command injection",
  severity: "critical",
  vulnerable_versions: "<3.0.0",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  fetchImpl: typeof fetch;
  calls: { osv: number; npm: number };
  fail: boolean;
}

function harness(): Harness {
  const state = { osv: 0, npm: 0, fail: false };

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (state.fail) {
      throw new Error("network down");
    }

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.endsWith("/v1/querybatch")) {
      state.osv += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        queries: { version: string; package: { name: string } }[];
      };
      const results = body.queries.map((query) => ({
        vulns:
          query.package.name === "evil" && query.version === "2.0.0"
            ? [OSV_VULN]
            : [],
      }));
      return json({ results });
    }

    if (url.endsWith("/-/npm/v1/security/advisories/bulk")) {
      state.npm += 1;
      return json({ evil: [NPM_ADVISORY] });
    }

    return new Response("not found", { status: 404 });
  };

  return {
    fetchImpl: fetchImpl as typeof fetch,
    calls: state,
    get fail() {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
  } as Harness;
}

function service(
  fetchImpl: typeof fetch,
  cacheDir: string,
  ttlMs?: number,
): AdvisoryService {
  return new AdvisoryService({
    cacheDir,
    fetchImpl,
    osvEndpoint: "https://osv.test",
    registry: "https://npm.test",
    now: () => NOW,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

test("unions OSV and npm advisories and normalizes them", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pyloros-advisory-"));
  const network = harness();

  try {
    const batch = await service(network.fetchImpl, cacheDir).query([
      { name: "evil", version: "2.0.0" },
      { name: "clean", version: "1.0.0" },
    ]);

    const evil = batch.entries.get("evil@2.0.0") ?? [];
    assert.deepEqual(
      evil.map((entry) => [entry.id, entry.severity]),
      [
        ["2", "critical"],
        ["GHSA-1", "high"],
      ],
    );
    assert.equal(evil[0]?.url, "https://npm.example/advisories/2");
    assert.deepEqual(batch.entries.get("clean@1.0.0"), []);

    assert.deepEqual(Object.keys(batch.snapshot.entries), ["evil@2.0.0"]);
    assert.deepEqual(batch.snapshot.sources, ["npm", "osv"]);
    assert.equal(batch.snapshot.snapshotAt, new Date(NOW).toISOString());
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("filters npm advisories by vulnerable_versions", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pyloros-advisory-"));
  const network = harness();

  try {
    const batch = await service(network.fetchImpl, cacheDir).query([
      { name: "evil", version: "3.5.0" },
    ]);

    assert.deepEqual(batch.entries.get("evil@3.5.0"), []);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("uses the cache within the TTL and refreshes when stale", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pyloros-advisory-"));
  const network = harness();
  const cached = service(network.fetchImpl, cacheDir, 60_000);

  try {
    await cached.query([{ name: "evil", version: "2.0.0" }]);
    assert.equal(network.calls.osv, 1);
    assert.equal(network.calls.npm, 1);

    await cached.query([{ name: "evil", version: "2.0.0" }]);
    assert.equal(network.calls.osv, 1);
    assert.equal(network.calls.npm, 1);

    const stale = service(network.fetchImpl, cacheDir, 0);
    await stale.query([{ name: "evil", version: "2.0.0" }]);
    assert.equal(network.calls.osv, 2);
    assert.equal(network.calls.npm, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("serves a fresh cache while the network is down", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pyloros-advisory-"));
  const network = harness();

  try {
    await service(network.fetchImpl, cacheDir, 60_000).query([
      { name: "evil", version: "2.0.0" },
    ]);

    network.fail = true;

    const offline = await service(network.fetchImpl, cacheDir, 60_000).query([
      { name: "evil", version: "2.0.0" },
    ]);

    assert.equal(offline.entries.get("evil@2.0.0")?.length, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("fails closed when advisory data is unreachable and uncached", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "pyloros-advisory-"));
  const network = harness();
  network.fail = true;

  try {
    await assert.rejects(
      service(network.fetchImpl, cacheDir).query([
        { name: "evil", version: "2.0.0" },
      ]),
      AdvisoryError,
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
