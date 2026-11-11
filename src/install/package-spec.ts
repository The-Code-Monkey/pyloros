import { UsageError } from "../core/errors.ts";

export interface PackageSpec {
  name: string;
  range?: string;
}

export function parsePackageSpec(value: string): PackageSpec {
  const separator = value.lastIndexOf("@");

  if (separator <= 0) {
    return { name: value };
  }

  const name = value.slice(0, separator);
  const range = value.slice(separator + 1);

  if (name.length === 0 || range.length === 0) {
    throw new UsageError(`invalid package specifier: ${value}`);
  }

  return { name, range };
}
