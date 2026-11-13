/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseCaptureResponse } from "../../src/memory/capture.ts";

/** Builds one well-formed candidate, so a test only states what it varies. */
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "A candidate",
    type: "fact",
    body: "Something worth keeping.",
    speaker: [{ name: "Aria", confident: true }],
    agents: [],
    tags: [],
    links: [],
    ...overrides,
  };
}

test("one unusable candidate costs one candidate, not its neighbours", () => {
  const warnings: string[] = [];
  const drafts = parseCaptureResponse(
    JSON.stringify({
      candidates: [
        candidate({ title: "Good one" }),
        candidate({ title: "Invented type", type: "philosophical-insight" }),
        candidate({ title: "Good two", type: "preference" }),
      ],
    }),
    5,
    undefined,
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["Good one", "Good two"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"Invented type"/u);
  assert.match(warnings[0]!, /invalid type/u);
});

test("a refused candidate that cannot name itself is still named in the warning", () => {
  const warnings: string[] = [];
  const drafts = parseCaptureResponse(
    JSON.stringify({
      candidates: [
        "not an object",
        candidate({ title: "", body: "no title" }),
        candidate({ title: "Good" }),
      ],
    }),
    5,
    undefined,
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["Good"],
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /\(untitled\)/u);
  assert.match(warnings[1]!, /\(untitled\)/u);
});

test("a reply in which nothing survives still fails, so the window is re-read", () => {
  assert.throws(
    () =>
      parseCaptureResponse(
        JSON.stringify({
          candidates: [
            candidate({ type: "philosophical-insight" }),
            candidate({ type: "also-not-a-type" }),
          ],
        }),
        5,
        undefined,
        () => {},
      ),
    /invalid type/u,
  );
});

test("surviving candidates keep their attribution and the cap still applies", () => {
  const drafts = parseCaptureResponse(
    JSON.stringify({
      candidates: [
        candidate({ title: "First", speaker: [{ name: "Aria", confident: true }, { name: "aria", confident: true }] }),
        candidate({ title: "Broken", speaker: "Aria" }),
        candidate({ title: "Third" }),
        candidate({ title: "Fourth" }),
      ],
    }),
    3,
    undefined,
    () => {},
  );

  // The cap is applied before parsing, so "Fourth" is never read.
  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["First", "Third"],
  );
  // Folding speakers happens after a candidate survives, not before.
  assert.deepEqual(drafts[0]!.speaker, [{ name: "Aria", confident: true }]);
});

test("a quarantined type is still dropped even when its neighbours survive", () => {
  const drafts = parseCaptureResponse(
    JSON.stringify({
      candidates: [candidate({ title: "A dream", type: "dream" }), candidate({ title: "A fact" })],
    }),
    5,
    undefined,
    () => {},
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["A fact"],
  );
});
