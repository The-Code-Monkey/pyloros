import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatFallbackRequest,
  parseFallbackChoice,
  terminalLink,
} from "../src/resolve/fallback.ts";
import type { FallbackRequest } from "../src/resolve/resolver.ts";
import { advisory } from "./helpers/advisories.ts";

const request: FallbackRequest = {
  name: "a",
  nodeVersion: "24.14.1",
  constraints: ["^2.0.0 (<root>)"],
  allowAdvisories: false,
  candidates: [
    {
      version: "2.0.0",
      advisories: [advisory("GHSA-1", { url: "https://osv.dev/vulnerability/GHSA-1" })],
      satisfiesConstraints: true,
    },
    {
      version: "1.5.0",
      advisories: [],
      satisfiesConstraints: false,
    },
  ],
};

test("formats candidates with plain URLs when hyperlinks are off", () => {
  const text = formatFallbackRequest(request, { hyperlinks: false });
  assert.match(text, /a@2\.0\.0/);
  assert.match(text, /GHSA-1 \(high\)/);
  assert.match(text, /outside declared ranges/);
  assert.match(text, /https:\/\/osv\.dev\/vulnerability\/GHSA-1/);
});

test("wraps advisory URLs in OSC 8 hyperlinks when on", () => {
  const text = formatFallbackRequest(request, { hyperlinks: true });
  assert.ok(text.includes("\u001b]8;;https://osv.dev/vulnerability/GHSA-1\u0007"));

  const link = terminalLink("https://example.invalid/x", "x", false);
  assert.equal(link, "x");
});

test("parses an exact name@version selection", () => {
  assert.equal(parseFallbackChoice("a@1.5.0", request)?.version, "1.5.0");
  assert.equal(parseFallbackChoice("  a@2.0.0  ", request)?.version, "2.0.0");
  assert.equal(parseFallbackChoice("1.5.0", request), undefined);
  assert.equal(parseFallbackChoice("b@1.5.0", request), undefined);
  assert.equal(parseFallbackChoice("a@9.9.9", request), undefined);
  assert.equal(parseFallbackChoice("", request), undefined);
});
