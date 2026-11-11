export const ExitCode = {
  Ok: 0,
  Generic: 1,
  Usage: 2,
  ResolutionConflict: 3,
  RuntimeContract: 4,
  AdvisoryBlock: 5,
  Integrity: 6,
  FrozenDrift: 7,
  InstallGate: 8,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
