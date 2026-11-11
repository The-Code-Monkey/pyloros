import type { ProjectManifest } from "../../src/core/manifest.ts";
import type { Packument, VersionManifest } from "../../src/registry/packument.ts";
import type { PackumentProvider } from "../../src/resolve/resolver.ts";

export function version(
  name: string,
  value: string,
  extra: Partial<VersionManifest> = {},
): VersionManifest {
  return {
    name,
    version: value,
    engines: { node: ">=18" },
    dist: {
      tarball: `https://registry.example/${name}/-/${name}-${value}.tgz`,
      integrity: "sha512-AAAA",
    },
    ...extra,
  };
}

export function packageDoc(name: string, versions: readonly VersionManifest[]): Packument {
  return {
    name,
    versions: Object.fromEntries(versions.map((entry) => [entry.version, entry])),
  };
}

export class FakeRegistry implements PackumentProvider {
  readonly #documents = new Map<string, Packument>();

  constructor(documents: readonly Packument[]) {
    for (const document of documents) {
      this.#documents.set(document.name, document);
    }
  }

  async getPackument(name: string): Promise<Packument> {
    const document = this.#documents.get(name);

    if (document === undefined) {
      throw new Error(`fake registry has no package: ${name}`);
    }

    return document;
  }
}

export function projectManifest(
  dependencies: Record<string, string> = {},
  optionalDependencies: Record<string, string> = {},
): ProjectManifest {
  return {
    directory: ".",
    dependencies,
    optionalDependencies,
    devDependencies: {},
    peerDependencies: {},
    policy: { allowScripts: {}, pins: {}, allowAdvisories: [] },
  };
}
