/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import {
  buildCapturePrompt,
  captureStartIndex,
  inferSpeakerName,
  parseCaptureResponse,
  recentTurnStart,
  serializeCaptureTranscript,
} from "../../src/memory/capture.ts";
import { CAPTURE_SYSTEM_PROMPT } from "../../src/memory/prompts.ts";
import { MEMORY_TYPES, isQuarantinedMemoryType } from "../../src/memory/schema.ts";

test("capture transcript includes user and custom text but omits binary data", () => {
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "1",
      parentId: null,
      timestamp: "2026-10-20T00:00:00Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Remember the blue cup." },
          { type: "image", data: "binary", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    },
    {
      type: "custom_message",
      id: "2",
      parentId: "1",
      timestamp: "2026-10-20T00:00:01Z",
      customType: "note",
      content: "A custom note.",
      display: false,
    },
  ];

  const transcript = serializeCaptureTranscript(entries);
  assert.match(transcript, /USER: Remember the blue cup\./);
  assert.match(transcript, /CUSTOM: A custom note\./);
  assert.doesNotMatch(transcript, /binary/);
});

test("an unknown cursor is bounded to the most recent turns", () => {
  const user = (id: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text: id }],
      timestamp: 1,
    },
  });
  // Non-user entries are interleaved to prove only user messages count.
  const note = (id: string): SessionEntry => ({
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    customType: "note",
    content: id,
    display: false,
  });
  const entries: SessionEntry[] = [
    user("u1"),
    note("a1"),
    user("u2"),
    note("a2"),
    user("u3"),
    note("a3"),
  ];

  // Five turns requested from a six-entry, three-turn branch: everything.
  assert.equal(recentTurnStart(entries, 5), 0);
  // The last two turns start at the first of them, not at what follows.
  assert.equal(recentTurnStart(entries, 2), 2);
  assert.equal(recentTurnStart(entries, 1), 4);
  // A single turn is the whole session.
  assert.equal(recentTurnStart(entries.slice(0, 2), 1), 0);
  // Degenerate limits never produce an empty window.
  assert.equal(recentTurnStart(entries, 0), 0);
  assert.equal(recentTurnStart(entries, Number.NaN), 0);
  assert.equal(recentTurnStart([], 3), 0);
});

test("a known cursor starts the read after itself", () => {
  const entry = (id: string): SessionEntry => ({
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    customType: "note",
    content: id,
    display: false,
  });
  const entries = [entry("e1"), entry("e2"), entry("e3")];

  assert.deepEqual(captureStartIndex(entries, "e2", 5), {
    startIndex: 2,
    cursorFound: true,
  });
  // A cursor at the leaf leaves nothing to read, which is what makes "nothing
  // pending" distinguishable from "never captured".
  assert.deepEqual(captureStartIndex(entries, "e3", 5), {
    startIndex: 3,
    cursorFound: true,
  });
  // No cursor at all is not the same as a cursor that was not found: the first
  // means nothing has been captured yet, so the whole branch is unread.
  assert.deepEqual(captureStartIndex(entries, undefined, 5), {
    startIndex: 0,
    cursorFound: false,
  });
  // A cursor the branch no longer contains falls back to the bounded window.
  assert.deepEqual(captureStartIndex(entries, "gone", 5), {
    startIndex: 0,
    cursorFound: false,
  });
});

test("the capture prompt offers exactly the capture-capable memory types", () => {
  const line = CAPTURE_SYSTEM_PROMPT.split("\n").find((entry) =>
    entry.includes("`type` must be exactly one of"),
  );
  assert.ok(line, "the capture prompt must name its type vocabulary");
  const offered = [...line.matchAll(/`([a-z-]+)`/gu)]
    .map((match) => match[1])
    .filter((value) => value !== "type");
  const expected = MEMORY_TYPES.filter(
    (type) => !isQuarantinedMemoryType(type),
  );
  assert.deepEqual(offered, expected);
});

test("capture prompt carries the transcript guard and candidate limit", () => {
  const prompt = buildCapturePrompt("USER: hello", 2);
  assert.match(prompt, /at most 2 durable memory candidates/);
  assert.match(prompt, /<transcript>\nUSER: hello\n<\/transcript>/);
});

test("explicit speaker introductions produce a capture hint", () => {
  assert.equal(
    inferSpeakerName("USER: My name is Aisling. Remember this."),
    "Aisling",
  );
  assert.equal(inferSpeakerName("USER: Remember this."), undefined);
});

test("capture response parsing accepts fenced JSON and filters quarantined types", () => {
  const candidates = parseCaptureResponse(
    `Here is the result:
\`\`\`json
{
  "candidates": [
    {
      "title": "Blue Cup",
      "type": "fact",
      "body": "The blue cup belongs on the second shelf.",
      "speaker": [{"name": "Aisling", "confident": true}],
      "tags": ["kitchen"]
    },
    {
      "title": "Cup Dream",
      "type": "dream",
      "body": "A dream about cups.",
      "speaker": []
    }
  ]
}
\`\`\``,
    5,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.title, "Blue Cup");
  assert.equal(candidates[0]?.type, "fact");
  assert.deepEqual(candidates[0]?.tags, ["kitchen"]);
});

test("capture response parsing rejects malformed candidates", () => {
  assert.throws(
    () => parseCaptureResponse("not json", 3),
    /candidates array/,
  );
  assert.throws(
    () =>
      parseCaptureResponse(
        '{"candidates":[{"title":"Bad","type":"unknown","body":"x","speaker":[]}]}',
        3,
      ),
    /invalid type/,
  );
});

test("capture response parsing drops generic speaker labels", () => {
  const candidates = parseCaptureResponse(
    '{"candidates":[{"title":"Generic","type":"fact","body":"x","speaker":[{"name":"USER","confident":true}]}]}',
    3,
  );
  assert.deepEqual(candidates, []);
});

test("generic speaker labels are replaced by an explicit speaker hint", () => {
  const candidates = parseCaptureResponse(
    '{"candidates":[{"title":"Tea","type":"preference","body":"Jasmine tea.","speaker":[{"name":"USER","confident":true}]}]}',
    3,
    "Aisling",
  );
  assert.equal(candidates[0]?.speaker[0]?.name, "Aisling");
});
