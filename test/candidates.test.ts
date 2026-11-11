import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Advisory,
  AdvisoryBatch,
  AdvisoryProvider,
  AdvisoryQuery,
} from "../src/advisories/types.ts";
import { selectCandidates } from "../src/resolve/candidates.ts";
import type {
  FallbackRequest,
  FallbackSelector,
} from "../src/resolve/types.ts";
import { FIXED_SNAPSHOT, FakeAdvisories, advisory } from "./helpers/advisories.ts";
import { packageDoc, version } from "./helpers/registry.ts";

const NODE = "24.14.1";

class RecordingAdvisories implements AdvisoryProvider {
  readonly calls: string[][] = [];
  readonly #fake: FakeAdvisories;

  constructor(entries: Record<string, Advisory[]>) {
    this.#fake = new FakeAdvisories(entries);
  }

  async query(queries: readonly AdvisoryQuery[]): Promise<AdvisoryBatch> {
    this.calls.push(
      queries.map((query) => `${query.name}@${query.version}`),
    );
    return this.#fake.query(queries);
  }
}

function context(
  advisories: RecordingAdvisories,
  extra: {
    preferred?: Record<string, string>;
    fallback?: FallbackSelector;
    allowAdvisories?: boolean;
  } = {},
) {
  return {
    nodeVersion: NODE,
    allowAdvisories: extra.allowAdvisories === true,
    now: () => new Date(FIXED_SNAPSHOT),
    ...(extra.preferred === undefined ? {} : { preferred: extra.preferred }),
    ...(extra.fallback === undefined ? {} : { fallback: extra.fallback }),
    async queryAdvisories(queries: readonly AdvisoryQuery[]) {
      if (queries.length === 0) {
        return new Map<string, readonly Advisory[]>();
      }

      const batch = await advisories.query(queries);
      return batch.entries;
    },
  };
}

function constraint(range: string) {
  return [{ range, from: "<root>" }];
}

test("returns clean candidates highest first", async () => {
  const advisories = new RecordingAdvisories({});
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0"), version("a", "2.0.0")]),
    constraint("*"),
    context(advisories),
  );

  assert.equal(outcome.kind, "candidates");
  assert.deepEqual(
    outcome.kind === "candidates"
      ? outcome.candidates.map((entry) => entry.version)
      : [],
    ["2.0.0", "1.0.0"],
  );
});

test("promotes a preferred version to the front", async () => {
  const advisories = new RecordingAdvisories({});
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0"), version("a", "1.5.0")]),
    constraint("*"),
    context(advisories, { preferred: { a: "1.0.0" } }),
  );

  assert.deepEqual(
    outcome.kind === "candidates"
      ? outcome.candidates.map((entry) => entry.version)
      : [],
    ["1.0.0", "1.5.0"],
  );
});

test("fails with a contract failure when every version excludes the runtime", async () => {
  const advisories = new RecordingAdvisories({});
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [
      version("a", "1.0.0", { engines: { node: ">=99" } }),
      version("a", "2.0.0", { engines: { node: ">=100" } }),
    ]),
    constraint("*"),
    context(advisories),
  );

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.kind === "failure" ? outcome.failure.kind : "", "contract");
});

test("accepts versions with no usable engines range", async () => {
  const advisories = new RecordingAdvisories({});
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0", { engines: {} })]),
    constraint("*"),
    context(advisories),
  );

  assert.equal(outcome.kind, "candidates");
});

test("skips affected versions and keeps the highest clean one", async () => {
  const advisories = new RecordingAdvisories({
    "a@2.0.0": [advisory("GHSA-1")],
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0"), version("a", "2.0.0")]),
    constraint("*"),
    context(advisories),
  );

  assert.deepEqual(
    outcome.kind === "candidates"
      ? outcome.candidates.map((entry) => entry.version)
      : [],
    ["1.0.0"],
  );
  assert.deepEqual(advisories.calls, [["a@1.0.0", "a@2.0.0"]]);
});

test("fails with an advisory failure when every satisfying version is affected", async () => {
  const advisories = new RecordingAdvisories({
    "a@2.0.0": [advisory("GHSA-1")],
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "2.0.0")]),
    constraint("^2.0.0"),
    context(advisories),
  );

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.kind === "failure" ? outcome.failure.kind : "", "advisory");
});

test("queries only the missing versions when building a fallback", async () => {
  const advisories = new RecordingAdvisories({
    "a@2.0.0": [advisory("GHSA-1")],
  });
  let request: FallbackRequest | undefined;
  const fallback: FallbackSelector = async (value) => {
    request = value;
    return { version: "1.5.0", reason: "clean downgrade" };
  };
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.5.0"), version("a", "2.0.0")]),
    constraint("^2.0.0"),
    context(advisories, { fallback }),
  );

  assert.equal(outcome.kind, "override");
  assert.equal(outcome.kind === "override" ? outcome.pin.version : "", "1.5.0");
  assert.deepEqual(outcome.kind === "override" ? outcome.pin.advisoryIds : [], []);
  assert.deepEqual(advisories.calls, [["a@2.0.0"], ["a@1.5.0"]]);
  assert.deepEqual(
    request?.candidates.map((entry) => [
      entry.version,
      entry.satisfiesConstraints,
    ]),
    [
      ["2.0.0", true],
      ["1.5.0", false],
    ],
  );
});

test("refuses an affected override without allowAdvisories", async () => {
  const advisories = new RecordingAdvisories({
    "a@2.0.0": [advisory("GHSA-2")],
  });
  const fallback: FallbackSelector = async () => ({
    version: "2.0.0",
    reason: "accept it",
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "2.0.0")]),
    constraint("*"),
    context(advisories, { fallback }),
  );

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.kind === "failure" ? outcome.failure.kind : "", "advisory");
});

test("records an affected override when allowAdvisories is on", async () => {
  const advisories = new RecordingAdvisories({
    "a@2.0.0": [advisory("GHSA-3")],
  });
  const fallback: FallbackSelector = async () => ({
    version: "2.0.0",
    reason: "accept it",
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "2.0.0")]),
    constraint("*"),
    context(advisories, { fallback, allowAdvisories: true }),
  );

  assert.equal(outcome.kind, "override");
  assert.deepEqual(
    outcome.kind === "override" ? outcome.pin.advisoryIds : [],
    ["GHSA-3"],
  );
});

test("offers a fallback when constraints conflict before selection", async () => {
  const advisories = new RecordingAdvisories({});
  const fallback: FallbackSelector = async () => ({
    version: "2.0.0",
    reason: "pick newer",
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0"), version("a", "2.0.0")]),
    [
      { range: "^1.0.0", from: "m1@1.0.0" },
      { range: "^2.0.0", from: "m2@1.0.0" },
    ],
    context(advisories, { fallback }),
  );

  assert.equal(outcome.kind, "override");
  assert.equal(outcome.kind === "override" ? outcome.pin.version : "", "2.0.0");
});

test("rejects an override without a reason", async () => {
  const advisories = new RecordingAdvisories({
    "a@1.0.0": [advisory("GHSA-4")],
  });
  const fallback: FallbackSelector = async () => ({
    version: "1.0.0",
    reason: "   ",
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0")]),
    constraint("*"),
    context(advisories, { fallback }),
  );

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.kind === "failure" ? outcome.failure.kind : "", "resolution");
});

test("rejects an override for an unavailable version", async () => {
  const advisories = new RecordingAdvisories({
    "a@1.0.0": [advisory("GHSA-5")],
  });
  const fallback: FallbackSelector = async () => ({
    version: "9.9.9",
    reason: "wrong",
  });
  const outcome = await selectCandidates(
    "a",
    packageDoc("a", [version("a", "1.0.0")]),
    constraint("*"),
    context(advisories, { fallback }),
  );

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.kind === "failure" ? outcome.failure.kind : "", "resolution");
});
