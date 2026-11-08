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
  buildCaptureWindow,
  captureStartIndex,
  parseCaptureResponse,
  recentTurnStart,
  serializeCaptureTranscript,
} from "../../src/memory/capture.ts";
import { CAPTURE_SYSTEM_PROMPT } from "../../src/memory/prompts.ts";
import { MEMORY_TYPES, isQuarantinedMemoryType } from "../../src/memory/schema.ts";

test("capture transcript includes user and person-authored custom text, and omits binary data", () => {
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
      customType: "pi-web.ask.answers",
      content: "A structured answer a person gave.",
      display: false,
    },
    {
      type: "custom_message",
      id: "3",
      parentId: "2",
      timestamp: "2026-10-20T00:00:02Z",
      customType: "harness.notice",
      content: "A status line nobody wrote.",
      display: false,
    },
  ];

  const transcript = serializeCaptureTranscript(entries);
  assert.match(transcript, /USER: Remember the blue cup\./);
  assert.match(transcript, /CUSTOM: A structured answer a person gave\./);
  assert.doesNotMatch(transcript, /status line nobody wrote/);
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

test("speaker names come from tags on the window's own messages", () => {
  const user = (id: string, text: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  });
  const assistant = (id: string, text: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
  });

  // One signed message names the speaker; the tag is not a phrase to infer
  // from, so an unsigned message beside it changes nothing.
  assert.deepEqual(
    buildCaptureWindow([user("u1", "\\>>Aria: the sweep ran"), user("u2", "thanks")]).names,
    ["Aria"],
  );
  // Several people, in the order they first appear, deduplicated by name.
  assert.deepEqual(
    buildCaptureWindow([
      user("u1", "\\>>Aria: the sweep ran"),
      user("u2", "[Iri] it did"),
      user("u3", "\\>>aria: and again"),
    ]).names,
    ["Aria", "Iri"],
  );
  // Assistant prose is not a person's signature, even when it looks like one.
  assert.deepEqual(
    buildCaptureWindow([user("u1", "the sweep ran"), assistant("a1", "-Aria")])
      .names,
    [],
  );
});

test("first-person phrasing no longer becomes a name", () => {
  const entry = (id: string, text: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  });
  // These are the transcript lines that used to produce a speaker hint of
  // "so", "not" and "working", which was then stamped onto every candidate.
  for (const text of [
    "I am so tired today",
    "I'm not sure we should",
    "I am working on the prompt",
    "my name is Aria",
  ]) {
    assert.deepEqual(buildCaptureWindow([entry("u1", text)]).names, []);
  }
});

test("the capture prompt states the attribution the window supports", () => {
  const one = buildCapturePrompt("USER: hi", 2, { names: ["Aria"] });
  assert.match(one, /The human speaker is Aria; use that concrete attribution name\./u);

  // Two names are stated as two, not collapsed into "the current speaker".
  const two = buildCapturePrompt("USER: hi", 2, { names: ["Aria", "Iri"] });
  assert.match(two, /More than one person is speaking: Aria, Iri\./u);
  assert.doesNotMatch(two, /The human speaker is/u);

  // Nothing to say means nothing said: the system prompt forbids inventing one.
  const none = buildCapturePrompt("USER: hi", 2, { names: [] });
  assert.doesNotMatch(none, /human speaker/u);
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

test("an unidentified speaker leaves an empty list, not a lost candidate", () => {
  const candidates = parseCaptureResponse(
    '{"candidates":[{"title":"Generic","type":"fact","body":"x","speaker":[{"name":"USER","confident":true}]}]}',
    3,
  );
  // The generic label is removed; the memory survives. Losing it would lose a
  // durable fact for the absence of a name.
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.speaker, []);
});

test("a candidate may name several speakers, and generic labels drop out of them", () => {
  const candidates = parseCaptureResponse(
    JSON.stringify({
      candidates: [
        {
          title: "Two people",
          type: "event",
          body: "They both agreed.",
          speaker: [
            { name: "Aisling", confident: true },
            { name: "Iri", confident: true },
            { name: "USER", confident: true },
          ],
        },
      ],
    }),
    3,
  );
  assert.deepEqual(
    candidates[0]?.speaker.map((speaker) => speaker.name),
    ["Aisling", "Iri"],
  );
});

test("a repeated name is folded into one record, and confidence upgrades", () => {
  const candidates = parseCaptureResponse(
    JSON.stringify({
      candidates: [
        {
          title: "Twice",
          type: "fact",
          body: "Said twice.",
          speaker: [
            { name: "Aisling", confident: false },
            { name: "aisling", confident: true },
          ],
        },
      ],
    }),
    3,
  );
  assert.equal(candidates[0]?.speaker.length, 1);
  assert.equal(candidates[0]?.speaker[0]?.name, "Aisling");
  assert.equal(candidates[0]?.speaker[0]?.confident, true);
});

test("generic speaker labels are replaced by a hint only when one person signed", () => {
  const candidates = parseCaptureResponse(
    '{"candidates":[{"title":"Tea","type":"preference","body":"Jasmine tea.","speaker":[{"name":"USER","confident":true}]}]}',
    3,
    { names: ["Aisling"] },
  );
  assert.equal(candidates[0]?.speaker[0]?.name, "Aisling");

  // With two people in the window there is no safe answer, so the label is
  // removed rather than handed to whoever spoke last — and the candidate stays,
  // with an empty speaker list.
  const ambiguous = parseCaptureResponse(
    '{"candidates":[{"title":"Tea","type":"preference","body":"Jasmine tea.","speaker":[{"name":"USER","confident":true}]}]}',
    3,
    { names: ["Aisling", "Iri"] },
  );
  assert.equal(ambiguous.length, 1);
  assert.deepEqual(ambiguous[0]?.speaker, []);
});

test("the names come from the messages the transcript still contains", () => {
  const user = (id: string, text: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  });
  const longAssistantText = "x".repeat(200);
  const assistant = (id: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-20T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: longAssistantText }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
  });

  const entries = [user("u1", "\\>>Aria: an older message"), assistant("a1")];
  // Wide enough for both: Aria signed what the model will read.
  assert.deepEqual(buildCaptureWindow(entries, 10_000).names, ["Aria"]);
  // Too narrow for Aria's message: it is dropped whole, so naming her would
  // tell the model about a speaker it cannot see.
  assert.deepEqual(buildCaptureWindow(entries, 150).names, []);
  assert.equal(buildCaptureWindow(entries, 150).transcript.includes("Aria"), false);
});
