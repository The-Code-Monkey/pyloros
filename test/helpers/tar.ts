import { gzipSync } from "node:zlib";

export interface TarInput {
  name: string;
  data?: string | Uint8Array;
  type?: "0" | "5" | "2";
  linkname?: string;
  mode?: number;
}

const BLOCK = 512;

function writeString(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  Buffer.from(value, "utf8").copy(header, offset, 0, length);
}

function writeOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  writeString(header, `${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
}

export function makeTar(
  inputs: readonly TarInput[],
  options: { gzip?: boolean } = {},
): Uint8Array {
  const chunks: Buffer[] = [];

  for (const input of inputs) {
    const body = input.data === undefined ? Buffer.alloc(0) : Buffer.from(input.data);
    const type = input.type ?? (input.data === undefined ? "5" : "0");
    const header = Buffer.alloc(BLOCK);

    writeString(header, input.name, 0, 100);
    writeOctal(header, input.mode ?? (type === "5" ? 0o755 : 0o644), 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, body.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");

    if (input.linkname !== undefined) {
      writeString(header, input.linkname, 157, 100);
    }

    writeString(header, "ustar\0", 257, 6);
    writeString(header, "00", 263, 2);

    let sum = 0;

    for (const byte of header) {
      sum += byte;
    }

    writeOctal(header, sum, 148, 8);

    chunks.push(header, body);

    const remainder = body.length % BLOCK;

    if (remainder !== 0) {
      chunks.push(Buffer.alloc(BLOCK - remainder));
    }
  }

  chunks.push(Buffer.alloc(BLOCK * 2));

  const archive = Buffer.concat(chunks);
  return new Uint8Array(options.gzip === false ? archive : gzipSync(archive));
}
