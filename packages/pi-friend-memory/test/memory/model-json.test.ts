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
import { parseDreamResponse } from "../../src/memory/dream.ts";
import { parseMergeResponse } from "../../src/memory/merge-writer.ts";
import { readModelJson } from "../../src/memory/model-json.ts";
import { parseSweepResponse } from "../../src/memory/sweep-model.ts";

test("a clean object is read without repair and without a warning", () => {
  const warnings: string[] = [];
  const reading = readModelJson('{"candidates":[]}', (message) =>
    warnings.push(message),
  );

  assert.deepEqual(reading.object, { candidates: [] });
  assert.equal(reading.repaired, false);
  assert.equal(reading.problem, undefined);
  assert.deepEqual(warnings, []);
});

test("a fenced or prose-wrapped object is read as it is", () => {
  const response = [
    "Sure, here is the JSON:",
    "```json",
    '{"body": "consolidated", "conflict": ""}',
    "```",
    "Let me know if you need changes.",
  ].join("\n");

  const reading = readModelJson(response);
  assert.deepEqual(reading.object, { body: "consolidated", conflict: "" });
  assert.equal(reading.repaired, false);
});

test("an unescaped quote inside a string is repaired, and the text survives", () => {
  // The reply that cost a live capture window on 2026-11-13: the second body
  // quotes a sentence without escaping it, while the first body escapes its own.
  const response =
    '{"candidates":[{"title":"Escaped","body":"a \\"narrow\\" answer"},' +
    '{"title":"Bare","body":"not the file. "Any answer derived carries ' +
    "something of it, so 'narrow' is achievable.\",\"tags\":[]}]}";

  const warnings: string[] = [];
  const reading = readModelJson(response, (message) => warnings.push(message));

  assert.equal(reading.repaired, true);
  const candidates = reading.object?.candidates;
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 2);
  const second = candidates[1] as { body: string; tags: string[] };
  assert.equal(
    second.body,
    'not the file. "Any answer derived carries something of it, so \'narrow\' is achievable.',
  );
  assert.deepEqual(second.tags, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /repaired before use/);
});

test("a missing comma and a trailing comma are both repaired", () => {
  const missing = readModelJson('{"body":"one" "conflict":""}');
  assert.equal(missing.repaired, true);
  assert.deepEqual(missing.object, { body: "one", conflict: "" });

  const trailing = readModelJson('{"body":"one","conflict":"",}');
  assert.equal(trailing.repaired, true);
  assert.deepEqual(trailing.object, { body: "one", conflict: "" });
});

test("an unreadable reply names the parser's complaint and its position", () => {
  const warnings: string[] = [];
  const reading = readModelJson("{ this is not JSON at all }", (message) =>
    warnings.push(message),
  );

  assert.equal(reading.object, undefined);
  assert.equal(reading.repaired, true);
  assert.match(reading.problem!, /is not valid JSON/);
  assert.deepEqual(warnings, []);
});

test("a repair salvages what it can rather than refusing the reply", () => {
  // Repair is a salvage operation, not a faithful round trip: this reply has a
  // stray comma inside an array, and the repair drops the incomplete element
  // instead of failing. Callers' own validation is what a damaged body meets,
  // and a body that still fits is better than an entire window lost.
  const reading = readModelJson('{"body": [1, ]}');

  assert.equal(reading.repaired, true);
  assert.deepEqual(reading.object, { body: [1] });
});

test("a reply with no object at all says so instead of blaming the parser", () => {
  const reading = readModelJson("I could not find anything worth remembering.");
  assert.equal(reading.object, undefined);
  assert.equal(reading.repaired, false);
  assert.match(reading.problem!, /does not contain a JSON object/);
});

test("a repaired capture reply yields every candidate it carried", () => {
  const response =
    '{"candidates":[{"title":"Boundary","type":"fact",' +
    '"body":"The boundary is what crosses it. "Any answer carries something ' +
    'of it."","speaker":[{"name":"Aria","confident":true}],' +
    '"agents":[],"tags":["privacy"],"links":[]}]}';

  const warnings: string[] = [];
  const drafts = parseCaptureResponse(response, 3, undefined, (message) =>
    warnings.push(message),
  );

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.title, "Boundary");
  assert.equal(
    drafts[0]!.body,
    'The boundary is what crosses it. "Any answer carries something of it."',
  );
  assert.equal(warnings.length, 1);
});

test("a reply with no candidates array is still refused by name", () => {
  assert.throws(
    () => parseCaptureResponse('{"memories":[]}', 3),
    /must contain a candidates array/,
  );
});

test("the sweep, dream and merge parsers read a repaired reply too", () => {
  const decisions = parseSweepResponse(
    '{"decisions":[{"slug":"alpha","action":"promote","reason":"the "only" one"}]}',
    ["alpha"],
    [],
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.reason, 'the "only" one');

  const dream = parseDreamResponse(
    '{"title":"a "dream"","narrative":"we walked","nodeSlugs":["a","b"]}',
    ["a", "b"],
    4,
  );
  assert.equal(dream.title, 'a "dream"');

  const merge = parseMergeResponse(
    '{"body":"one "merged" body","conflict":""}',
  );
  assert.equal(merge.body, 'one "merged" body');
});
