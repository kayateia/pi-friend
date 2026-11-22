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
      emotional_flavour: "neutral",
      tags: [],
      links: [],
      source: "",
    },
  };
}

test("decay is volume-relative: memories created since a use age it", () => {
  const old = makeNode("old", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  const newer = Array.from({ length: 10 }, (_, index) =>
    makeNode(
      `new-${index}`,
      `2026-01-${String(index + 2).padStart(2, "0")}T00:00:00Z`,
    ),
  );

  const updates = computeDecayUpdates([old, ...newer]);
  const oldUpdate = updates.find((update) => update.slug === "old");

  assert.equal(oldUpdate?.decayWeight, 0.5);
});

test("a node used after everything else was created stays fresh", () => {
  const used = makeNode(
    "used",
    "2026-01-01T00:00:00Z",
    "2026-03-01T00:00:00Z",
  );
  used.frontMatter.decay_weight = 0.2;
  const newer = Array.from({ length: 20 }, (_, index) =>
    makeNode(
      `new-${index}`,
      `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    ),
  );

  const updates = computeDecayUpdates([used, ...newer]);

  // Nothing has been written since it was last used, so nothing ages it. This
  // is the whole point of moving `last_used` to the moment of use: the sweep no
  // longer needs an access log to know it.
  assert.equal(
    updates.find((update) => update.slug === "used")?.decayWeight,
    1,
  );
});

test("only nodes whose weight changes are returned", () => {
  const settled = makeNode("settled", "2026-01-01T00:00:00Z");
  settled.frontMatter.decay_weight = 1;

  assert.deepEqual(computeDecayUpdates([settled]), []);

  settled.frontMatter.decay_weight = 0.9;
  assert.deepEqual(computeDecayUpdates([settled]), [
    { slug: "settled", decayWeight: 1 },
  ]);
});

test("archived nodes weigh nothing", () => {
  const gone = makeNode("gone", "2026-01-01T00:00:00Z");
  gone.frontMatter.status = "archived";

  assert.deepEqual(computeDecayUpdates([gone]), [
    { slug: "gone", decayWeight: 0 },
  ]);
});

test("candidate decay uses canonical volume and expires at the floor", () => {
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
    makeNode("expired", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  ];
  canonical.at(-1)!.frontMatter.decay_weight = 0.05;

  const plan = planCandidateDecay([candidate, canonical.at(-1)!], canonical);
  assert.equal(
    plan.updates.find((update) => update.slug === "candidate")?.decayWeight,
    0.3333,
  );
  assert.deepEqual(plan.expiredSlugs, ["expired"]);
});

test("a candidate's decay never rises, however often it is retrieved", () => {
  const candidate = makeNode("candidate", "2026-01-01T00:00:00Z");
  candidate.frontMatter.status = "candidate";
  // Already lower than the volume curve would make it, because it aged before.
  candidate.frontMatter.decay_weight = 0.2;

  const plan = planCandidateDecay([candidate], [candidate]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.expiredSlugs, []);
});
