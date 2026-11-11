export const TOOL_NAME = "pyloros";
export const TOOL_VERSION = "0.0.0";

export function currentNodeVersion(): string {
  return process.version.replace(/^v/u, "");
}

export function currentNodeAbi(): string {
  return process.versions.modules ?? "unknown";
}
