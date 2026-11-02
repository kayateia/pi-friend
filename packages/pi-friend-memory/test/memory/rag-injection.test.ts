/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import type { UserMessage } from "@earendil-works/pi-ai";
import test from "node:test";
import {
  EMPTY_RAG_BLOCK,
  buildRagQuery,
  containsRagContext,
  injectRagContext,
  latestUserPrompt,
  ragBlockForDelivery,
  type RagAgentMessage,
} from "../../src/memory/rag-injection.ts";

const BLOCK = "## Recalled memories\nMemory block";

test("position zero prepends to the latest user message and preserves images", () => {
  const messages: UserMessage[] = [
    { role: "user", content: "first", timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: "latest" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      timestamp: 2,
    },
  ];

  const injected = injectRagContext(messages, BLOCK, 0);
  const latest = injected[1];
  assert.ok(latest && latest.role === "user");
  assert.ok(Array.isArray(latest.content));
  assert.equal(latest.content.length, 3);
  assert.deepEqual(latest.content[0], { type: "text", text: BLOCK });
  assert.deepEqual(injected[0], messages[0]);
});

test("negative positions select earlier user prompts and fall back to latest", () => {
  const messages: UserMessage[] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];

  const previous = injectRagContext(messages, BLOCK, -1);
  assert.equal(userContent(previous, 0), `${BLOCK}\n\nfirst`);
  assert.equal(userContent(previous, 1), "second");

  const fallback = injectRagContext([messages[0]!], BLOCK, -2);
  assert.equal(userContent(fallback, 0), `${BLOCK}\n\nfirst`);
});

test("no-op cases keep the original message array", () => {
  const messages: UserMessage[] = [
    { role: "user", content: "hello", timestamp: 1 },
  ];
  assert.equal(injectRagContext(messages, "", 0), messages);
  assert.equal(injectRagContext([], BLOCK, 0).length, 0);
});

test("latest user prompt supports text and mixed-content messages", () => {
  const prompt = latestUserPrompt([
    { role: "user", content: "older", timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: "latest" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      timestamp: 2,
    },
  ]);

  assert.deepEqual(prompt, { index: 1, prompt: "latest" });
  assert.equal(latestUserPrompt([]), undefined);
});

test("RAG query includes only visible assistant prose before the latest user", () => {
  const messages: RagAgentMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "The previous visible answer." },
        {
          type: "toolCall",
          id: "tool-1",
          name: "bash",
          arguments: { command: "ignored" },
        },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "ignored tool output" }],
      isError: false,
      timestamp: 2,
    },
    { role: "user", content: "Tell me about that.", timestamp: 3 },
  ];

  const query = buildRagQuery(messages);
  assert.deepEqual(query, {
    userIndex: 2,
    userPrompt: "Tell me about that.",
    assistantText: "The previous visible answer.",
    query: "The previous visible answer.\n\nTell me about that.",
  });
});

test("RAG delivery checks detect the injected block in user messages", () => {
  const messages: UserMessage[] = [
    { role: "user", content: "hello", timestamp: 1 },
  ];
  const injected = injectRagContext(messages, BLOCK, 0);

  assert.equal(containsRagContext(injected, BLOCK), true);
  assert.equal(containsRagContext(messages, BLOCK), false);
});

test("debug runs receive an empty RAG block when retrieval selects nothing", () => {
  assert.equal(ragBlockForDelivery("", false), "");
  assert.equal(ragBlockForDelivery("", true), EMPTY_RAG_BLOCK);
  assert.equal(ragBlockForDelivery(BLOCK, true), BLOCK);
});

/** Narrows one context message to a user message for assertions. */
function userContent(
  messages: RagAgentMessage[],
  index: number,
): UserMessage["content"] {
  const message = messages[index];
  if (!message || message.role !== "user") {
    throw new Error(`Expected user message at index ${index}.`);
  }
  return message.content;
}
