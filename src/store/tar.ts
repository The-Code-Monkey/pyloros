import { gunzipSync } from "node:zlib";
import { TarError } from "../core/errors.ts";

export type TarEntry =
  | { type: "file"; path: string; data: Uint8Array; mode: number }
  | { type: "dir"; path: string; mode: number };

const BLOCK = 512;
const MAX_ENTRIES = 200_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const TEXT = new TextDecoder();

function decode(bytes: Uint8Array): string {
  return TEXT.decode(bytes);
}

function isGzip(input: Uint8Array): boolean {
  return (input.at(0) ?? 0) === 0x1f && (input.at(1) ?? 0) === 0x8b;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(
  block: Uint8Array,
  offset: number,
  length: number,
  label: string,
): number {
  const field = block.subarray(offset, offset + length);
  const first = field.at(0) ?? 0;

  if ((first & 0x80) !== 0) {
    throw new TarError(`tar ${label} uses base-256 encoding, which is not supported`);
  }

  let value = 0;
  let seen = false;

  for (const byte of field) {
    if (byte === 0) {
      break;
    }

    if (byte === 0x20) {
      if (seen) {
        break;
      }
      continue;
    }

    if (byte < 0x30 || byte > 0x37) {
      throw new TarError(`tar ${label} is not a valid octal number`);
    }

    value = value * 8 + (byte - 0x30);
    seen = true;
  }

  return value;
}

function verifyChecksum(header: Uint8Array): void {
  const stored = readOctal(header, 148, 8, "checksum");
  let sum = 0;

  for (let index = 0; index < BLOCK; index += 1) {
    const byte = header[index] ?? 0;
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }

  if (sum !== stored) {
    throw new TarError(`tar header checksum mismatch: stored ${stored}, computed ${sum}`);
  }
}

function normalizePath(raw: string): string {
  let value = raw.replace(/\0+$/u, "");

  while (value.startsWith("./")) {
    value = value.slice(2);
  }

  if (value.length === 0 || value === ".") {
    throw new TarError("tar entry has an empty path");
  }

  if (value.includes("\0")) {
    throw new TarError("tar entry path contains a NUL byte");
  }

  if (value.includes("\\")) {
    throw new TarError(`tar entry path contains a backslash: ${value}`);
  }

  if (value.startsWith("/")) {
    throw new TarError(`tar entry path is absolute: ${value}`);
  }

  if (/^[A-Za-z]:/u.test(value)) {
    throw new TarError(`tar entry path has a drive prefix: ${value}`);
  }

  const parts = value.split("/");

  if (value.endsWith("/")) {
    parts.pop();
  }

  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new TarError(`tar entry path escapes the archive root: ${raw}`);
    }
  }

  return parts.join("/");
}

function parsePax(body: Uint8Array): Map<string, string> {
  const text = decode(body);
  const records = new Map<string, string>();
  let index = 0;

  while (index < text.length) {
    const space = text.indexOf(" ", index);

    if (space === -1) {
      throw new TarError("malformed pax header: missing record length");
    }

    const length = Number(text.slice(index, space));

    if (!Number.isInteger(length) || length <= 0) {
      throw new TarError("malformed pax header: invalid record length");
    }

    const end = index + length;

    if (end > text.length) {
      throw new TarError("malformed pax header: truncated record");
    }

    const record = text.slice(space + 1, end);

    if (!record.endsWith("\n")) {
      throw new TarError("malformed pax header: record does not end with a newline");
    }

    const payload = record.slice(0, -1);
    const equals = payload.indexOf("=");

    if (equals <= 0) {
      throw new TarError("malformed pax header: missing key/value separator");
    }

    records.set(payload.slice(0, equals), payload.slice(equals + 1));
    index = end;
  }

  return records;
}

function decompress(input: Uint8Array): Uint8Array {
  if (!isGzip(input)) {
    return input;
  }

  try {
    return gunzipSync(input, { maxOutputLength: MAX_TOTAL_BYTES });
  } catch (error) {
    throw new TarError("tarball could not be decompressed", { cause: error });
  }
}

export function extractTar(input: Uint8Array): TarEntry[] {
  const tar = decompress(input);
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    if (isZeroBlock(header)) {
      break;
    }

    verifyChecksum(header);

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12, "size");
    const archiveMode = readOctal(header, 100, 8, "mode");
    const mode = (archiveMode & 0o111) === 0 ? 0o644 : 0o755;
    const bodyStart = offset + BLOCK;
    const bodyEnd = bodyStart + size;

    if (bodyEnd > tar.length) {
      throw new TarError("tar archive is truncated");
    }

    const body = tar.subarray(bodyStart, bodyEnd);
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "x" || typeflag === "g") {
      const records = parsePax(body);

      if (typeflag === "x") {
        const path = records.get("path");

        if (path !== undefined) {
          paxPath = path;
        }
      }

      continue;
    }

    if (typeflag === "L") {
      longName = decode(body).replace(/\0+$/u, "");
      continue;
    }

    if (typeflag === "K") {
      throw new TarError("tar long link names are not supported");
    }

    const name = paxPath ?? longName ?? readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    paxPath = undefined;
    longName = undefined;

    if (typeflag === "0" || typeflag === "\0") {
      const path = normalizePath(fullName);

      if (seen.has(path)) {
        throw new TarError(`duplicate tar entry: ${path}`);
      }

      if (size > MAX_FILE_BYTES) {
        throw new TarError(`tar entry is too large: ${path}`);
      }

      total += size;

      if (total > MAX_TOTAL_BYTES) {
        throw new TarError("tar archive expands beyond the size limit");
      }

      seen.add(path);
      entries.push({ type: "file", path, data: body.slice(), mode });
      continue;
    }

    if (typeflag === "5") {
      const path = normalizePath(fullName);

      if (seen.has(path)) {
        throw new TarError(`duplicate tar entry: ${path}`);
      }

      seen.add(path);
      entries.push({ type: "dir", path, mode: 0o755 });
      continue;
    }

    if (typeflag === "1" || typeflag === "2") {
      throw new TarError(`tar links are not allowed: ${fullName}`);
    }

    throw new TarError(
      `unsupported tar entry type ${JSON.stringify(typeflag)}: ${fullName}`,
    );
  }

  if (entries.length === 0) {
    throw new TarError("tar archive contains no entries");
  }

  if (entries.length > MAX_ENTRIES) {
    throw new TarError("tar archive contains too many entries");
  }

  return entries;
}
