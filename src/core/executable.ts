import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env[`PYLOROS_${name.toUpperCase()}`];

  if (override !== undefined && override.length > 0) {
    return isExecutable(override) ? override : undefined;
  }

  const searchPath = env["PATH"] ?? "";

  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    const candidate = join(directory, name);

    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
