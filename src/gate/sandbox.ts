import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { findExecutable } from "../core/executable.ts";
import { GateError } from "../core/errors.ts";
import type {
  SandboxRequest,
  SandboxResult,
  SandboxRunner,
} from "./types.ts";

const DEFAULT_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];

export interface BubblewrapOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  systemPaths?: readonly string[];
  nodePrefix?: string;
}

function nodePrefix(): string {
  return dirname(dirname(process.execPath));
}

export function bubblewrapArgs(
  request: SandboxRequest,
  options: BubblewrapOptions = {},
): string[] {
  const systemPaths = options.systemPaths ?? DEFAULT_SYSTEM_PATHS;
  const prefix = options.nodePrefix ?? nodePrefix();
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--clearenv",
  ];

  for (const path of systemPaths) {
    if (existsSync(path)) {
      args.push("--ro-bind", path, path);
    }
  }

  if (existsSync(prefix)) {
    args.push("--ro-bind", prefix, prefix);
  }

  for (const mount of request.readOnly) {
    if (existsSync(mount.source)) {
      args.push("--ro-bind", mount.source, mount.target);
    }
  }

  for (const mount of request.writable) {
    args.push("--bind", mount.source, mount.target);
  }

  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push("--chdir", request.cwd, "--setenv", "HOME", "/tmp");

  for (const [key, value] of Object.entries(request.env)) {
    args.push("--setenv", key, value);
  }

  args.push(request.command, ...request.args);

  return args;
}

export class BubblewrapSandbox implements SandboxRunner {
  readonly #binary: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #systemPaths: readonly string[] | undefined;
  readonly #nodePrefix: string | undefined;

  constructor(options: BubblewrapOptions = {}) {
    this.#binary = options.binary;
    this.#env = options.env ?? process.env;
    this.#systemPaths = options.systemPaths;
    this.#nodePrefix = options.nodePrefix;
  }

  #resolve(): string | undefined {
    return this.#binary ?? findExecutable("bwrap", this.#env);
  }

  async available(): Promise<boolean> {
    const binary = this.#resolve();

    if (binary === undefined) {
      return false;
    }

    const result = spawnSync(binary, ["--version"], {
      env: this.#env,
      stdio: "ignore",
    });

    return result.status === 0;
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const binary = this.#resolve();

    if (binary === undefined) {
      throw new GateError(
        "bubblewrap is not available; refusing to run allowlisted scripts",
      );
    }

    const args = bubblewrapArgs(request, {
      ...(this.#systemPaths === undefined
        ? {}
        : { systemPaths: this.#systemPaths }),
      ...(this.#nodePrefix === undefined ? {} : { nodePrefix: this.#nodePrefix }),
    });

    return new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        env: this.#env,
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      let stderr = "";
      let timedOut = false;

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64_000) {
          stderr += chunk.toString("utf8");
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;

        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }, request.timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new GateError("bubblewrap could not be started", { cause: error }));
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal,
          timedOut,
          ...(stderr.length === 0 ? {} : { stderr }),
        });
      });
    });
  }
}
