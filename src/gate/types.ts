export type ProvenanceStatus = "verified" | "absent";

export interface ProvenanceVerification {
  status: ProvenanceStatus;
  attestationDigest?: string;
  subjectIntegrity?: string;
  verifiedAt?: string;
}

export interface ProvenanceRequest {
  name: string;
  version: string;
  integrity: string;
  tarball: Uint8Array;
}

export interface ProvenanceVerifier {
  verify(request: ProvenanceRequest): Promise<ProvenanceVerification>;
}

export type ScriptAction = "executed" | "skipped";

export interface GateScriptDecision {
  name: string;
  action: ScriptAction;
  reason?: string;
}

export interface GatePackageReport {
  name: string;
  version: string;
  provenance: ProvenanceVerification;
  native: boolean;
  reason?: string;
  scripts: GateScriptDecision[];
}

export interface GateReport {
  packages: GatePackageReport[];
}

export interface SandboxMount {
  source: string;
  target: string;
}

export interface SandboxRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  writable: readonly SandboxMount[];
  readOnly: readonly SandboxMount[];
  timeoutMs: number;
}

export interface SandboxResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr?: string;
}

export interface SandboxRunner {
  available(): Promise<boolean>;
  run(request: SandboxRequest): Promise<SandboxResult>;
}
