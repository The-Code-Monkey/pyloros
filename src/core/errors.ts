import { ExitCode } from "./exit-codes.ts";

export class PylorosError extends Error {
  readonly exitCode: number;

  constructor(
    message: string,
    exitCode: number = ExitCode.Generic,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class RegistryError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Generic, options);
  }
}

export class ManifestError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Usage, options);
  }
}

export class ResolutionError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.ResolutionConflict, options);
  }
}

export class RuntimeContractError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.RuntimeContract, options);
  }
}

export class AdvisoryError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.AdvisoryBlock, options);
  }
}

export class LockfileError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Integrity, options);
  }
}

export class FrozenDriftError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.FrozenDrift, options);
  }
}

export class PlatformError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.RuntimeContract, options);
  }
}

export class ProvenanceError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Integrity, options);
  }
}

export class GateError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.InstallGate, options);
  }
}

export class UsageError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Usage, options);
  }
}

export class IntegrityError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Integrity, options);
  }
}

export class TarError extends PylorosError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Integrity, options);
  }
}
