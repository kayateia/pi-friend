/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { inspect } from "node:util";
import type {
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { summarizeHook } from "../../src/debug/hook-log.ts";

test("lifecycle logging omits raw payloads and context functions", () => {
  const event = {
    type: "before_agent_start",
    largeToolResult: "x".repeat(20_000),
  } as unknown as ExtensionEvent;
  const context = {
    cwd: "/tmp/project",
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session-1",
    },
    model: { id: "model-a" },
    thinkingLevel: "minimal",
    isIdle: () => false,
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
    signal: undefined,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000 }),
    getSystemPrompt: () => "prompt",
  } as unknown as ExtensionContext;

  const summary = summarizeHook(event, context);
  const serialized = inspect(summary);

  assert.equal(summary.eventType, "before_agent_start");
  assert.equal(summary.context.sessionId, "session-1");
  assert.equal(summary.context.model, "model-a");
  assert.equal(summary.context.systemPromptChars, 6);
  assert.doesNotMatch(serialized, /\[Function/u);
  assert.doesNotMatch(serialized, /largeToolResult/u);
});
