/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resolveConfiguredModel,
  runNestedModel,
} from "../../src/memory/model-call.ts";
import { resetReportedMessages } from "../../src/memory/report.ts";

/** Narrows the context's optional model for the helper's signature. */
function requireModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> {
  const model = ctx.model;
  if (model === undefined) {
    throw new Error("test context has no model");
  }
  return model;
}

interface Call {
  reasoning?: string;
}

/** A context whose nested calls are answered by the supplied function. */
function fakeContext(
  answer: (call: Call) => "ok" | "reject",
  calls: Call[],
): ExtensionContext {
  const model = {
    provider: "test",
    id: "model-a",
  };
  return {
    model,
    modelRegistry: {
      streamSimple: (
        _model: unknown,
        _context: unknown,
        options: { reasoning?: string },
      ) => {
        calls.push({ reasoning: options.reasoning });
        const outcome = answer(options);
        return (async function* stream() {
          if (outcome === "reject") {
            yield {
              type: "error" as const,
              error: { errorMessage: "thinking level not supported" },
            };
            return;
          }
          yield {
            type: "done" as const,
            message: {
              content: [{ type: "text" as const, text: "answer" }],
            },
          };
        })();
      },
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
}

test("a rejected thinking level is retried once without it", async () => {
  resetReportedMessages();
  const calls: Call[] = [];
  const warnings: string[] = [];
  const ctx = fakeContext(
    (call) => (call.reasoning === undefined ? "ok" : "reject"),
    calls,
  );

  const text = await runNestedModel(ctx, requireModel(ctx), {
    systemPrompt: "system",
    userContent: "user",
    maxTokens: 10,
    timeoutMs: 1_000,
    label: "sweep",
    reportWarning: (message) => warnings.push(message),
    thinkingLevel: "high",
  });

  assert.equal(text, "answer");
  assert.deepEqual(calls, [
    { reasoning: "high" },
    { reasoning: undefined },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /rejected thinking level "high"/);
  assert.match(warnings[0] ?? "", /check the configured thinking_level/i);
});

test("the retry warning is raised once per model and level", async () => {
  resetReportedMessages();
  const warnings: string[] = [];
  const ctx = fakeContext(() => "reject", []);
  const options = {
    systemPrompt: "system",
    userContent: "user",
    maxTokens: 10,
    timeoutMs: 1_000,
    label: "sweep",
    reportWarning: (message: string) => warnings.push(message),
    thinkingLevel: "high" as const,
  };

  await assert.rejects(() => runNestedModel(ctx, requireModel(ctx), options));
  // The second attempt fails too, but it already warned: a level that never
  // works should not re-announce itself on every pass.
  assert.equal(warnings.length, 1);
});

test("no thinking level means one call and no retry", async () => {
  resetReportedMessages();
  const calls: Call[] = [];
  const warnings: string[] = [];
  const ctx = fakeContext(() => "ok", calls);

  await runNestedModel(ctx, requireModel(ctx), {
    systemPrompt: "system",
    userContent: "user",
    maxTokens: 10,
    timeoutMs: 1_000,
    reportWarning: (message) => warnings.push(message),
  });

  assert.deepEqual(calls, [{ reasoning: undefined }]);
  assert.deepEqual(warnings, []);
});

test("an unresolvable configured model warns and falls back to the session model", () => {
  const warnings: string[] = [];
  const ctx = {
    model: { provider: "session", id: "current" },
    modelRegistry: { find: () => undefined },
  } as unknown as ExtensionContext;

  const malformed = resolveConfiguredModel(ctx, "no-slash", "sweep", (message) =>
    warnings.push(message),
  );
  assert.equal(malformed, ctx.model);

  const missing = resolveConfiguredModel(
    ctx,
    "test/absent",
    "sweep",
    (message) => warnings.push(message),
  );
  assert.equal(missing, ctx.model);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /must use provider\/model-id/);
  assert.match(warnings[1] ?? "", /was not found/);
});
