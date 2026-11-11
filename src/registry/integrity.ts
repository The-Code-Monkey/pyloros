import { createHash, timingSafeEqual } from "node:crypto";
import { IntegrityError } from "../core/errors.ts";

const ALGORITHMS = ["sha512", "sha384", "sha256", "sha1"] as const;

type Algorithm = (typeof ALGORITHMS)[number];

export interface Sri {
  algorithm: Algorithm;
  digest: Buffer;
}

function isAlgorithm(value: string): value is Algorithm {
  return (ALGORITHMS as readonly string[]).includes(value);
}

function decodeBase64(value: string, token: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new IntegrityError(`invalid base64 digest in integrity: ${token}`);
  }
  return Buffer.from(value, "base64");
}

export function parseIntegrity(integrity: string): Sri[] {
  const tokens = integrity.trim().split(/\s+/u).filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new IntegrityError("integrity value is empty");
  }

  return tokens.map((token) => {
    const withoutOptions = token.split("?")[0] ?? "";
    const dash = withoutOptions.indexOf("-");

    if (dash <= 0 || dash === withoutOptions.length - 1) {
      throw new IntegrityError(`invalid integrity token: ${token}`);
    }

    const algorithm = withoutOptions.slice(0, dash);
    const encoded = withoutOptions.slice(dash + 1);

    if (!isAlgorithm(algorithm)) {
      throw new IntegrityError(`unsupported integrity algorithm: ${algorithm}`);
    }

    return { algorithm, digest: decodeBase64(encoded, token) };
  });
}

export function verifyIntegrity(data: Uint8Array, integrity: string): void {
  const candidates = parseIntegrity(integrity);

  for (const candidate of candidates) {
    const actual = createHash(candidate.algorithm).update(data).digest();

    if (
      actual.length === candidate.digest.length &&
      timingSafeEqual(actual, candidate.digest)
    ) {
      return;
    }
  }

  throw new IntegrityError("tarball integrity mismatch");
}

export function verifyShasum(data: Uint8Array, shasum: string): void {
  if (!/^[0-9a-f]{40}$/iu.test(shasum)) {
    throw new IntegrityError("invalid sha1 shasum");
  }

  const actual = createHash("sha1").update(data).digest();
  const expected = Buffer.from(shasum, "hex");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new IntegrityError("tarball shasum mismatch");
  }
}

export function sha512Hex(data: Uint8Array): string {
  return createHash("sha512").update(data).digest("hex");
}

export function sha512Sri(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}
