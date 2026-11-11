import { createRequire } from "node:module";

export interface SemverOptions {
  includePrerelease?: boolean;
}

export interface SemverApi {
  valid(version: string, options?: SemverOptions): string | null;
  validRange(range: string, options?: SemverOptions): string | null;
  satisfies(version: string, range: string, options?: SemverOptions): boolean;
  rcompare(a: string, b: string, options?: SemverOptions): number;
  compare(a: string, b: string, options?: SemverOptions): number;
}

const require = createRequire(import.meta.url);
const semver = require("../vendor/semver/index.js") as SemverApi;

export default semver;
