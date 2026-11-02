/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDecayUpdates,
  planCandidateDecay,
} from "../../src/memory/decay.ts";
import type { ParsedMemoryNode } from "../../src/memory/schema.ts";

/** Builds one canonical node fixture. */
function makeNode(
  slug: string,
  created: string,
  lastUsed = created,
): ParsedMemoryNode {
  return {
    slug,
    body: "\nBody.\n",
    frontMatter: {
      title: slug,
      type: "fact",
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created,
      last_used: lastUsed,
      use_count: 0,
      decay_weight: 1,
      status: "active",
      emotional_flavor: "neutral",
      tags: [],
      supersedes: [],
      superseded_by: "",
      links: [],
      source: "",
    },
  };
}

test("access resets decay and updates last-used metadata", () => {
  const node = makeNode(
    "remembered",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  const updates = computeDecayUpdates(
    [node],
    [
      JSON.stringify({
        timestamp: "2026-01-05T00:00:00Z",
        slug: "remembered",
        path: "nodes/remembered.md",
      }),
    ].join("\n"),
  );

  assert.deepEqual(updates, [
    {
      slug: "remembered",
      useCount: 1,
      lastUsed: "2026-01-05T00:00:00Z",
      decayWeight: 1,
    },
  ]);
});

test("decay is volume-relative rather than wall-clock based", () => {
  const old = makeNode(
    "old",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  const newer = Array.from({ length: 10 }, (_, index) =>
    makeNode(
      `new-${index}`,
      `2026-01-${String(index + 2).padStart(2, "0")}T00:00:00Z`,
    ),
  );
  const updates = computeDecayUpdates([old, ...newer], "");
  const oldUpdate = updates.find((update) => update.slug === "old");

  assert.equal(oldUpdate?.decayWeight, 0.5);
  assert.equal(
    updates.some((update) => update.slug === "new-0"),
    true,
  );
});

test("malformed access-log records are reported without aborting decay", () => {
  const node = makeNode(
    "remembered",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  const reported: Array<{ label: string; error: unknown }> = [];

  computeDecayUpdates(
    [node],
    '{"timestamp":"not-a-date"}\nnot-json',
    { reportError: (label, error) => reported.push({ label, error }) },
  );

  assert.deepEqual(
    reported.map((entry) => entry.label),
    ["access log parse", "access log parse"],
  );
  assert.match(String(reported[0]?.error), /line 1/u);
  assert.match(String(reported[1]?.error), /line 2/u);
});

test("candidate decay uses canonical volume, ignores access, and expires at floor", () => {
  const candidate = makeNode(
    "candidate",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  candidate.frontMatter.status = "candidate";
  candidate.frontMatter.decay_weight = 1;
  const canonical = [
    ...Array.from({ length: 20 }, (_, index) =>
      makeNode(
        `canonical-${index}`,
        `2026-01-${String(index + 2).padStart(2, "0")}T00:00:00Z`,
      ),
    ),
    makeNode(
      "expired",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ),
  ];
  canonical.at(-1)!.frontMatter.decay_weight = 0.05;

  const plan = planCandidateDecay([candidate, canonical.at(-1)!], canonical);
  assert.equal(
    plan.updates.find((update) => update.slug === "candidate")?.decayWeight,
    0.3333,
  );
  assert.deepEqual(plan.expiredSlugs, ["expired"]);
});
