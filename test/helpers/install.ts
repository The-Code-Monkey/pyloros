import type { Registry } from "../../src/install/install-session.ts";
import type {
  ProvenanceVerification,
  ProvenanceVerifier,
  SandboxRequest,
  SandboxResult,
  SandboxRunner,
} from "../../src/gate/types.ts";
import type { Packument, VersionManifest } from "../../src/registry/packument.ts";
import type { Platform } from "../../src/store/platform.ts";
import { FIXED_SNAPSHOT } from "./advisories.ts";

export const PLATFORM: Platform = { os: "linux", cpu: "x64", libc: "glibc" };
export const NODE_VERSION = "24.14.1";
export const NODE_ABI = "137";

export const VERIFIED: ProvenanceVerification = {
  status: "verified",
  attestationDigest: "digest",
  subjectIntegrity: "sha512-subject",
  verifiedAt: FIXED_SNAPSHOT,
};

export const ABSENT: ProvenanceVerification = { status: "absent" };

export function verified(digest = "digest"): ProvenanceVerification {
  return {
    status: "verified",
    attestationDigest: digest,
    subjectIntegrity: "sha512-subject",
    verifiedAt: FIXED_SNAPSHOT,
  };
}

export interface RegistryEntry {
  name: string;
  version: string;
  manifest: VersionManifest;
  data?: Uint8Array;
}

export class FakeRegistry implements Registry {
  readonly #entries: Map<string, RegistryEntry>;
  readonly #delayMs: number;
  active = 0;
  maxActive = 0;

  constructor(
    entries: readonly RegistryEntry[],
    options: { delayMs?: number } = {},
  ) {
    this.#entries = new Map(
      entries.map((item) => [`${item.name}@${item.version}`, item]),
    );
    this.#delayMs = options.delayMs ?? 0;
  }

  async getPackument(name: string): Promise<Packument> {
    const versions: Record<string, VersionManifest> = {};

    for (const item of this.#entries.values()) {
      if (item.name === name) {
        versions[item.version] = item.manifest;
      }
    }

    if (Object.keys(versions).length === 0) {
      throw new Error(`no package ${name}`);
    }

    const latest = Object.keys(versions).sort().at(-1) as string;

    return { name, versions, "dist-tags": { latest } };
  }

  async getTarball(manifest: VersionManifest): Promise<Uint8Array> {
    const item = this.#entries.get(`${manifest.name}@${manifest.version}`);

    if (item?.data === undefined) {
      throw new Error(`no tarball for ${manifest.name}@${manifest.version}`);
    }

    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      if (this.#delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
      }

      return item.data;
    } finally {
      this.active -= 1;
    }
  }
}

export class FakeProvenance implements ProvenanceVerifier {
  readonly #result: ProvenanceVerification;

  constructor(result: ProvenanceVerification = VERIFIED) {
    this.#result = result;
  }

  async verify(): Promise<ProvenanceVerification> {
    return this.#result;
  }
}

export class FakeSandbox implements SandboxRunner {
  readonly requests: SandboxRequest[] = [];
  readonly #available: boolean;
  readonly #result: SandboxResult;

  constructor(
    availableOrExit: boolean | number = true,
    result: SandboxResult = { exitCode: 0, signal: null, timedOut: false },
  ) {
    this.#available = typeof availableOrExit === "boolean" ? availableOrExit : true;
    this.#result =
      typeof availableOrExit === "number"
        ? { ...result, exitCode: availableOrExit }
        : result;
  }

  async available(): Promise<boolean> {
    return this.#available;
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    this.requests.push(request);
    return this.#result;
  }
}
