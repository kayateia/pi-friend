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
  inferSpeakerName,
  parseCaptureResponse,
  serializeCaptureTranscript,
} from "../../src/memory/capture.ts";

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

test("capture response parsing accepts fenced JSON and filters dreams", () => {
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
