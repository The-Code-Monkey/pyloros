import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry } from "../core/config.ts";
import { ProvenanceError } from "../core/errors.ts";
import { sha512Hex, sha512Sri } from "../registry/integrity.ts";
import { ProcessCosignRunner, type CosignRunner } from "./cosign.ts";
import type {
  ProvenanceRequest,
  ProvenanceVerification,
  ProvenanceVerifier,
} from "./types.ts";

const DEFAULT_IDENTITY_REGEXP = "^https://github\\.com/";
const DEFAULT_ISSUER = "https://token.actions.githubusercontent.com";

export interface ProvenanceVerifierOptions {
  registry?: string;
  fetchImpl?: typeof fetch;
  cosign?: CosignRunner;
  identityRegexp?: string;
  issuer?: string;
  timeoutMs?: number;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function encodeName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("%2F");
}

function decodePayload(bundle: Record<string, unknown>): Record<string, unknown> {
  const envelope = isRecord(bundle["dsseEnvelope"])
    ? bundle["dsseEnvelope"]
    : undefined;
  const encoded = envelope?.["payload"] ?? bundle["payload"];

  if (typeof encoded !== "string") {
    throw new ProvenanceError("attestation bundle has no DSSE payload");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new ProvenanceError("attestation payload is not valid JSON", {
      cause: error,
    });
  }

  if (!isRecord(payload)) {
    throw new ProvenanceError("attestation payload is not an object");
  }

  return payload;
}

function assertSubject(
  payload: Record<string, unknown>,
  tarball: Uint8Array,
): void {
  const subjects = payload["subject"];

  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new ProvenanceError("attestation has no subject");
  }

  const sha512 = sha512Hex(tarball);
  const sha256 = sha256Hex(tarball);

  for (const subject of subjects) {
    if (!isRecord(subject) || !isRecord(subject["digest"])) {
      continue;
    }

    const digest = subject["digest"];

    if (digest["sha512"] === sha512 || digest["sha256"] === sha256) {
      return;
    }
  }

  throw new ProvenanceError(
    "attestation subject digest does not match the tarball",
  );
}

export function absentProvenanceVerifier(): ProvenanceVerifier {
  return {
    async verify(): Promise<ProvenanceVerification> {
      return { status: "absent" };
    },
  };
}

export class CosignProvenanceVerifier implements ProvenanceVerifier {
  readonly #registry: string;
  readonly #fetch: typeof fetch;
  readonly #cosign: CosignRunner;
  readonly #identityRegexp: string;
  readonly #issuer: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: ProvenanceVerifierOptions = {}) {
    this.#registry = (options.registry ?? defaultRegistry()).replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#cosign = options.cosign ?? new ProcessCosignRunner();
    this.#identityRegexp =
      options.identityRegexp ??
      process.env.PYLOROS_CERTIFICATE_IDENTITY_REGEXP ??
      DEFAULT_IDENTITY_REGEXP;
    this.#issuer =
      options.issuer ??
      process.env.PYLOROS_CERTIFICATE_OIDC_ISSUER ??
      DEFAULT_ISSUER;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
  }

  async verify(request: ProvenanceRequest): Promise<ProvenanceVerification> {
    const selected = await this.#fetchAttestation(request.name, request.version);

    if (selected === undefined) {
      return { status: "absent" };
    }

    assertSubject(selected.payload, request.tarball);

    if (!(await this.#cosign.available())) {
      return { status: "absent" };
    }

    const attestationDigest = sha256Hex(
      new TextEncoder().encode(JSON.stringify(selected.bundle)),
    );
    const directory = await mkdtemp(join(tmpdir(), "pyloros-provenance-"));

    try {
      const bundlePath = join(directory, "bundle.json");
      const blobPath = join(directory, "package.tgz");

      await writeFile(bundlePath, JSON.stringify(selected.bundle), { mode: 0o600 });
      await writeFile(blobPath, request.tarball, { mode: 0o600 });

      await this.#cosign.verify({
        bundlePath,
        blobPath,
        identityRegexp: this.#identityRegexp,
        issuer: this.#issuer,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    return {
      status: "verified",
      attestationDigest,
      subjectIntegrity: sha512Sri(request.tarball),
      verifiedAt: this.#now().toISOString(),
    };
  }

  async #fetchAttestation(
    name: string,
    version: string,
  ): Promise<{ bundle: Record<string, unknown>; payload: Record<string, unknown> } | undefined> {
    const url = `${this.#registry}/-/npm/v1/attestations/${encodeName(name)}@${version}`;
    let response: Response;

    try {
      const fetchImpl = this.#fetch;
      response = await fetchImpl(url, {
        headers: new Headers({ accept: "application/json" }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ProvenanceError(`could not fetch attestations for ${name}@${version}`, {
        cause: error,
      });
    }

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new ProvenanceError(
        `attestation endpoint responded ${response.status} for ${name}@${version}`,
      );
    }

    const body = (await response.json()) as unknown;

    if (!isRecord(body) || !Array.isArray(body["attestations"])) {
      throw new ProvenanceError("attestation endpoint returned an unexpected response");
    }

    const attestations = body["attestations"].filter(isRecord);

    if (attestations.length === 0) {
      return undefined;
    }

    const provenance =
      attestations.find((entry) => {
        const predicate = entry["predicateType"];
        return typeof predicate === "string" && /provenance|slsa/iu.test(predicate);
      }) ?? attestations[0];

    if (provenance === undefined || !isRecord(provenance["bundle"])) {
      throw new ProvenanceError("attestation is missing a Sigstore bundle");
    }

    const bundle = provenance["bundle"];

    return { bundle, payload: decodePayload(bundle) };
  }
}
