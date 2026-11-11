#!/usr/bin/env node
import { addCommand } from "./commands/add.ts";
import { auditCommand } from "./commands/audit.ts";
import { checkCommand } from "./commands/check.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { removeCommand } from "./commands/remove.ts";
import { updateCommand } from "./commands/update.ts";
import { whyCommand } from "./commands/why.ts";
import { ExitCode } from "./core/exit-codes.ts";
import { PylorosError } from "./core/errors.ts";
import { TOOL_NAME, TOOL_VERSION } from "./core/tool.ts";

function help(): string {
  return [
    `${TOOL_NAME} - security-first npm client`,
    "",
    `Usage: ${TOOL_NAME} <command> [options]`,
    "",
    "Commands:",
    "  init      create a package.json",
    "  install   install from the lockfile, or resolve if none exists",
    "  add       add a dependency",
    "  remove    remove a dependency",
    "  update    re-resolve, highest clean version",
    "  audit     report advisories, provenance, and Gate status",
    "  why       explain a package's version",
    "  check     verify the lockfile and node_modules",
    "",
    "Options:",
    "  --json    machine-readable output",
    "",
  ].join("\n");
}

function run(
  command: string,
  rest: readonly string[],
  directory: string,
  json: boolean,
): Promise<number> {
  switch (command) {
    case "init":
      return initCommand(rest, directory, json);
    case "install":
      return installCommand(rest, directory, json);
    case "add":
      return addCommand(rest, directory, json);
    case "remove":
      return removeCommand(rest, directory, json);
    case "update":
      return updateCommand(rest, directory, json);
    case "audit":
      return auditCommand(rest, directory, json);
    case "why":
      return whyCommand(rest, directory, json);
    case "check":
      return checkCommand(rest, directory, json);
    default:
      process.stderr.write(`${TOOL_NAME}: unknown command: ${command}\n`);
      return Promise.resolve(ExitCode.Usage);
  }
}

async function main(rawArgs: readonly string[]): Promise<number> {
  const json = rawArgs.includes("--json");
  const args = rawArgs.filter((arg) => arg !== "--json");
  const first = args[0];

  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(help());
    return ExitCode.Ok;
  }

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${TOOL_NAME} ${TOOL_VERSION}\n`);
    return ExitCode.Ok;
  }

  return run(first, args.slice(1), process.cwd(), json);
}

const jsonRequested = process.argv.slice(2).includes("--json");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof PylorosError) {
    if (jsonRequested) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          exitCode: error.exitCode,
          error: error.message,
        })}\n`,
      );
    } else {
      process.stderr.write(`${TOOL_NAME}: ${error.message}\n`);
    }

    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);

    if (jsonRequested) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          exitCode: ExitCode.Generic,
          error: message,
        })}\n`,
      );
    } else {
      process.stderr.write(`${TOOL_NAME}: ${message}\n`);
    }

    process.exitCode = ExitCode.Generic;
  }
}
