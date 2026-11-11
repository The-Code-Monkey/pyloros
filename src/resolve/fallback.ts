import { createInterface } from "node:readline/promises";
import type {
  FallbackCandidate,
  FallbackRequest,
  FallbackSelector,
} from "./resolver.ts";

export interface HyperlinkOptions {
  hyperlinks?: boolean;
}

export function terminalLink(url: string, text: string, enabled: boolean): string {
  return enabled ? `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007` : text;
}

function describeCandidate(candidate: FallbackCandidate): string {
  const notes: string[] = [];

  if (candidate.advisories.length === 0) {
    notes.push("clean");
  } else {
    notes.push(
      `advisories: ${candidate.advisories
        .map((advisory) => `${advisory.id} (${advisory.severity})`)
        .join(", ")}`,
    );
  }

  if (!candidate.satisfiesConstraints) {
    notes.push("outside declared ranges");
  }

  if (candidate.deprecated !== undefined) {
    notes.push("deprecated");
  }

  return notes.join("; ");
}

export function formatFallbackRequest(
  request: FallbackRequest,
  options: HyperlinkOptions = {},
): string {
  const hyperlinks = options.hyperlinks ?? true;
  const lines = [
    `No clean version of ${request.name} can be selected for Node ${request.nodeVersion}.`,
    `Constraints: ${request.constraints.length === 0 ? "none" : request.constraints.join(", ")}`,
    "",
  ];

  for (const candidate of request.candidates) {
    lines.push(
      `  ${request.name}@${candidate.version}  ${describeCandidate(candidate)}`,
    );

    for (const advisory of candidate.advisories) {
      lines.push(`    ${terminalLink(advisory.url, advisory.url, hyperlinks)}`);
    }
  }

  lines.push(
    "",
    `Select ${request.name}@<version>, or press Enter to abort.`,
  );

  return lines.join("\n");
}

export function parseFallbackChoice(
  input: string,
  request: FallbackRequest,
): FallbackCandidate | undefined {
  const trimmed = input.trim();
  const prefix = `${request.name}@`;

  if (!trimmed.startsWith(prefix)) {
    return undefined;
  }

  const version = trimmed.slice(prefix.length);
  return request.candidates.find((candidate) => candidate.version === version);
}

export interface InteractiveSelectorOptions {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  allowAdvisories: boolean;
}

export function createInteractiveSelector(
  options: InteractiveSelectorOptions,
): FallbackSelector {
  return async (request: FallbackRequest) => {
    const readline = createInterface({
      input: options.input,
      output: options.output,
    });

    try {
      options.output.write(
        `${formatFallbackRequest(request, {
          hyperlinks: options.output.isTTY === true,
        })}\n`,
      );

      const answer = await readline.question("selected version: ");
      const candidate = parseFallbackChoice(answer, request);

      if (candidate === undefined) {
        options.output.write("aborted\n");
        return undefined;
      }

      if (candidate.advisories.length > 0 && !options.allowAdvisories) {
        options.output.write(
          "refusing an affected version without --allow-advisories\n",
        );
        return undefined;
      }

      const reason = (await readline.question("reason for the override: ")).trim();

      if (reason.length === 0) {
        options.output.write("an override needs a reason\n");
        return undefined;
      }

      return { version: candidate.version, reason };
    } finally {
      readline.close();
    }
  };
}
