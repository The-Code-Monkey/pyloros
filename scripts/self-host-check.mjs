import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const directory = await mkdtemp(join(tmpdir(), "pyloros-self-host-"));

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

try {
  const cliCheck = await stat(cli).catch(() => undefined);

  if (cliCheck === undefined) {
    throw new Error("dist/cli.js is missing; run npm run build first");
  }

  for (const entry of ["package.json", "tsconfig.json", "src", "types"]) {
    await cp(join(root, entry), join(directory, entry), { recursive: true });
  }

  const install = run(process.execPath, [cli, "install", "--json"], directory, {
    ...process.env,
    PYLOROS_CACHE_DIR: join(directory, "cache"),
  });

  if (install.status !== 0) {
    throw new Error(install.stderr || install.stdout || "install failed");
  }

  const tsc = join(directory, "node_modules", "typescript", "bin", "tsc");
  const typecheck = run(process.execPath, [tsc, "-p", "tsconfig.json", "--noEmit"], directory);

  if (typecheck.status !== 0) {
    throw new Error(typecheck.stderr || typecheck.stdout || "typecheck failed");
  }

  process.stdout.write("pyloros self-host check passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
