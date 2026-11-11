import { UsageError } from "../core/errors.ts";
import { createSelectFallback } from "../install/select-fallback.ts";
import { createInteractiveSelector } from "../resolve/fallback.ts";
import type { FallbackSelector } from "../resolve/resolver.ts";

export interface ParsedFlags {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

export function parseFlags(
  args: readonly string[],
  spec: { booleans?: readonly string[]; values?: readonly string[] },
): ParsedFlags {
  const booleanFlags = new Set(spec.booleans ?? []);
  const valueFlags = new Set(spec.values ?? []);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (booleanFlags.has(arg)) {
      booleans.add(arg);
      continue;
    }

    if (valueFlags.has(arg)) {
      const value = args[index + 1];

      if (value === undefined) {
        throw new UsageError(`${arg} needs a value`);
      }

      values.set(arg, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  return { positionals, values, booleans };
}

export function selectorFor(options: {
  select: string | undefined;
  allowAdvisories: boolean;
}): FallbackSelector | undefined {
  if (options.select !== undefined) {
    return createSelectFallback(options.select);
  }

  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    return createInteractiveSelector({
      input: process.stdin,
      output: process.stdout,
      allowAdvisories: options.allowAdvisories,
    });
  }

  return undefined;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function scriptSummary(scripts: {
  executed: string[];
  skipped: string[];
}): void {
  for (const script of scripts.executed) {
    process.stdout.write(`pyloros: ran ${script}\n`);
  }

  for (const script of scripts.skipped) {
    process.stdout.write(`pyloros: skipped ${script}\n`);
  }
}
