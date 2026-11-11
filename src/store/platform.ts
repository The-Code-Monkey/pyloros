export type Libc = "glibc" | "musl";

export interface Platform {
  os: string;
  cpu: string;
  libc?: Libc;
}

export interface PlatformConstraints {
  os?: readonly string[];
  cpu?: readonly string[];
  libc?: readonly string[];
}

function detectLibc(): Libc | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const glibc = report?.header?.glibcVersionRuntime;

    if (typeof glibc === "string" && glibc.length > 0) {
      return "glibc";
    }

    return "musl";
  } catch {
    return undefined;
  }
}

export function currentPlatform(): Platform {
  const libc = detectLibc();

  return {
    os: process.platform,
    cpu: process.arch,
    ...(libc === undefined ? {} : { libc }),
  };
}

function listMatches(
  value: string | undefined,
  list: readonly string[] | undefined,
): boolean {
  if (list === undefined || list.length === 0) {
    return true;
  }

  const positive = list.filter((entry) => !entry.startsWith("!"));
  const negative = list
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1));

  if (value !== undefined && negative.includes(value)) {
    return false;
  }

  if (positive.length === 0) {
    return true;
  }

  if (positive.includes("*")) {
    return true;
  }

  return value !== undefined && positive.includes(value);
}

export function matchesPlatform(
  constraints: PlatformConstraints,
  platform: Platform,
): boolean {
  return (
    listMatches(platform.os, constraints.os) &&
    listMatches(platform.cpu, constraints.cpu) &&
    listMatches(platform.libc, constraints.libc)
  );
}
