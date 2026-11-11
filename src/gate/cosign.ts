import { spawn } from "node:child_process";
import { findExecutable } from "../core/executable.ts";
import { GateError, ProvenanceError } from "../core/errors.ts";

export interface CosignRequest {
  bundlePath: string;
  blobPath: string;
  identityRegexp: string;
  issuer: string;
}

export interface CosignRunner {
  available(): Promise<boolean>;
  verify(request: CosignRequest): Promise<void>;
}

export interface ProcessCosignOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

export class ProcessCosignRunner implements CosignRunner {
  readonly #binary: string | undefined;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: ProcessCosignOptions = {}) {
    this.#binary = options.binary;
    this.#env = options.env ?? process.env;
  }

  #resolve(): string | undefined {
    return this.#binary ?? findExecutable("cosign", this.#env);
  }

  async available(): Promise<boolean> {
    return this.#resolve() !== undefined;
  }

  async verify(request: CosignRequest): Promise<void> {
    const binary = this.#resolve();

    if (binary === undefined) {
      throw new GateError(
        "cosign is not available; refusing to run allowlisted scripts",
      );
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        binary,
        [
          "verify-blob",
          "--bundle",
          request.bundlePath,
          "--certificate-identity-regexp",
          request.identityRegexp,
          "--certificate-oidc-issuer",
          request.issuer,
          request.blobPath,
        ],
        {
          env: this.#env,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64_000) {
          stderr += chunk.toString("utf8");
        }
      });
      child.on("error", (error) => {
        reject(new GateError("cosign could not be started", { cause: error }));
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new ProvenanceError(
            `cosign rejected the attestation (exit ${String(code)}): ${stderr.trim()}`,
          ),
        );
      });
    });
  }
}
