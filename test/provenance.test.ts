import assert from "node:assert/strict";
import { test } from "node:test";
import { GateError, ProvenanceError } from "../src/core/errors.ts";
import { sha512Hex } from "../src/registry/integrity.ts";
import {
  CosignProvenanceVerifier,
  absentProvenanceVerifier,
} from "../src/gate/provenance.ts";
import type { CosignRequest, CosignRunner } from "../src/gate/cosign.ts";
import { FIXED_SNAPSHOT } from "./helpers/advisories.ts";

const TARBALL = new TextEncoder().encode("tarball bytes");
const REGISTRY = "https://registry.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function attestation(digest = sha512Hex(TARBALL)): unknown {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "pkg", digest: { sha512: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
  };

  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            payloadType: "application/vnd.in-toto+json",
            signatures: [],
          },
        },
      },
    ],
  };
}

class FakeCosign implements CosignRunner {
  readonly #mode: "ok" | "invalid" | "missing";
  calls = 0;

  constructor(mode: "ok" | "invalid" | "missing" = "ok") {
    this.#mode = mode;
  }

  async available(): Promise<boolean> {
    return this.#mode !== "missing";
  }

  async verify(_request: CosignRequest): Promise<void> {
    this.calls += 1;

    if (this.#mode === "missing") {
      throw new GateError("cosign is not available");
    }

    if (this.#mode === "invalid") {
      throw new ProvenanceError("bad signature");
    }
  }
}

function verifier(
  fetchImpl: typeof fetch,
  cosign: CosignRunner = new FakeCosign(),
  now = () => new Date(FIXED_SNAPSHOT),
) {
  return new CosignProvenanceVerifier({
    registry: REGISTRY,
    fetchImpl,
    cosign,
    now,
  });
}

test("returns absent when the registry has no attestation", async () => {
  const result = await verifier(async () => json({}, 404)).verify({
    name: "pkg",
    version: "1.0.0",
    integrity: "sha512-AAAA",
    tarball: TARBALL,
  });

  assert.deepEqual(result, { status: "absent" });
});

test("returns verified when the subject and signature check out", async () => {
  let requested = "";
  let bundlePath = "";
  let blobPath = "";
  const cosign: CosignRunner = {
    async available() {
      return true;
    },
    async verify(request) {
      bundlePath = request.bundlePath;
      blobPath = request.blobPath;
    },
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    requested = typeof input === "string" ? input : String(input);
    return json(attestation());
  }) as typeof fetch;

  const result = await verifier(fetchImpl, cosign).verify({
    name: "@scope/pkg",
    version: "1.2.3",
    integrity: "sha512-AAAA",
    tarball: TARBALL,
  });

  assert.equal(result.status, "verified");
  assert.match(result.attestationDigest ?? "", /^[0-9a-f]{64}$/u);
  assert.match(result.subjectIntegrity ?? "", /^sha512-/u);
  assert.equal(result.verifiedAt, FIXED_SNAPSHOT);
  assert.ok(requested.endsWith("/-/npm/v1/attestations/%40scope%2Fpkg@1.2.3"));
  assert.ok(bundlePath.endsWith("bundle.json"));
  assert.ok(blobPath.endsWith("package.tgz"));
});

test("rejects an attestation whose subject does not match the tarball", async () => {
  const fetchImpl = (async () => json(attestation("0".repeat(128)))) as typeof fetch;

  await assert.rejects(
    verifier(fetchImpl).verify({
      name: "pkg",
      version: "1.0.0",
      integrity: "sha512-AAAA",
      tarball: TARBALL,
    }),
    ProvenanceError,
  );
});

test("rejects a bad signature", async () => {
  const fetchImpl = (async () => json(attestation())) as typeof fetch;

  await assert.rejects(
    verifier(fetchImpl, new FakeCosign("invalid")).verify({
      name: "pkg",
      version: "1.0.0",
      integrity: "sha512-AAAA",
      tarball: TARBALL,
    }),
    ProvenanceError,
  );
});

test("returns absent when cosign is unavailable", async () => {
  const fetchImpl = (async () => json(attestation())) as typeof fetch;

  const result = await verifier(fetchImpl, new FakeCosign("missing")).verify({
    name: "pkg",
    version: "1.0.0",
    integrity: "sha512-AAAA",
    tarball: TARBALL,
  });

  assert.deepEqual(result, { status: "absent" });
});

test("fails closed when the attestation endpoint errors", async () => {
  const fetchImpl = (async () => json({}, 500)) as typeof fetch;

  await assert.rejects(
    verifier(fetchImpl).verify({
      name: "pkg",
      version: "1.0.0",
      integrity: "sha512-AAAA",
      tarball: TARBALL,
    }),
    ProvenanceError,
  );
});

test("the absent verifier never touches the network", async () => {
  const result = await absentProvenanceVerifier().verify({
    name: "pkg",
    version: "1.0.0",
    integrity: "sha512-AAAA",
    tarball: TARBALL,
  });

  assert.deepEqual(result, { status: "absent" });
});
