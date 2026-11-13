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
import { runCaptureModel } from "../../src/memory/capture-runner.ts";
import type { AutoCaptureConfig } from "../../src/memory/config.ts";

const CONFIG = {
  enabled: true,
  everyTurns: 5,
  idleTimeoutMs: 600_000,
  maxCandidates: 5,
} as unknown as AutoCaptureConfig;

/**
 * A context whose nested calls answer with `replies` in order.
 *
 * The prompts are recorded so a test can assert what the retry actually asked
 * for, which is the part a wrong implementation gets subtly wrong.
 */
function scriptedContext(replies: string[]): {
  ctx: ExtensionContext;
  systemPrompts: string[];
  userPrompts: string[];
} {
  const queue = [...replies];
  const systemPrompts: string[] = [];
  const userPrompts: string[] = [];
  const ctx = {
    model: { provider: "test", id: "model-a" },
    modelRegistry: {
      streamSimple: (_model: unknown, options: { systemPrompt?: string; messages?: unknown[] }) => {
        systemPrompts.push(String(options.systemPrompt ?? ""));
        userPrompts.push(JSON.stringify(options.messages ?? []));
        const text = queue.shift() ?? "";
        return (async function* stream() {
          yield {
            type: "done" as const,
            message: {
              role: "assistant",
              content: text === "" ? [] : [{ type: "text" as const, text }],
              provider: "test",
              model: "model-a",
              responseModel: "model-a-2026",
              usage: { input: 100, output: 20 },
              stopReason: "stop",
            },
          };
        })();
      },
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
  return { ctx, systemPrompts, userPrompts };
}

/** Builds one well-formed capture candidate. */
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

/** Wraps candidates in the object shape a capture reply uses. */
function reply(...candidates: Record<string, unknown>[]): string {
  return JSON.stringify({ candidates });
}

test("an invented type is repaired by one retry, silently", async () => {
  const { ctx, userPrompts } = scriptedContext([
    reply(
      candidate({ title: "Good one" }),
      candidate({ title: "Invented type", type: "philosophical-insight" }),
    ),
    '["preference"]',
  ]);

  const warnings: string[] = [];
  const drafts = await runCaptureModel(
    ctx,
    CONFIG,
    "transcript",
    { names: [] },
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["Good one", "Invented type"],
  );
  assert.equal(drafts[1]!.type, "preference");
  // Nothing reached a person: the candidate was repaired, not refused.
  assert.deepEqual(warnings, []);
  // The retry asked for a label, and said which labels exist.
  assert.match(userPrompts[1]!, /philosophical-insight/u);
  assert.match(userPrompts[1]!, /`fact`.*`preference`.*`event`.*`person-note`/u);
});

test("the retry names only the candidates that need a type", async () => {
  const { ctx, userPrompts } = scriptedContext([
    reply(
      candidate({ title: "Fine" }),
      candidate({ title: "Wrong label", type: "vibe" }),
      candidate({ title: "Also fine", type: "event" }),
    ),
    '["fact"]',
  ]);

  await runCaptureModel(ctx, CONFIG, "transcript", { names: [] }, () => {});

  assert.match(userPrompts[1]!, /Wrong label/u);
  assert.doesNotMatch(userPrompts[1]!, /"Fine"/u);
  assert.doesNotMatch(userPrompts[1]!, /Also fine/u);
});

test("a retry that answers with the wrong number of types is ignored", async () => {
  const { ctx } = scriptedContext([
    reply(
      candidate({ title: "Good one" }),
      candidate({ title: "Bad one", type: "vibe" }),
      candidate({ title: "Bad two", type: "vibe" }),
    ),
    // Two candidates were refused; one type cannot relabel both.
    '["fact"]',
  ]);

  const warnings: string[] = [];
  const drafts = await runCaptureModel(
    ctx,
    CONFIG,
    "transcript",
    { names: [] },
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["Good one"],
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /"Bad one"/u);
  assert.match(warnings[1]!, /"Bad two"/u);
});

test("a retry that invents a type again leaves that candidate refused", async () => {
  const { ctx } = scriptedContext([
    reply(
      candidate({ title: "First", type: "vibe" }),
      candidate({ title: "Second", type: "vibe" }),
    ),
    '["not-a-type","event"]',
  ]);

  const warnings: string[] = [];
  const drafts = await runCaptureModel(
    ctx,
    CONFIG,
    "transcript",
    { names: [] },
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["Second"],
  );
  assert.equal(drafts[0]!.type, "event");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"First"/u);
});

test("a retry that fixes every candidate keeps the whole reply", async () => {
  const { ctx } = scriptedContext([
    reply(
      candidate({ title: "One", type: "vibe" }),
      candidate({ title: "Two", type: "vibe" }),
    ),
    '["fact","person-note"]',
  ]);

  const warnings: string[] = [];
  const drafts = await runCaptureModel(
    ctx,
    CONFIG,
    "transcript",
    { names: [] },
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["One", "Two"],
  );
  assert.deepEqual(warnings, []);
});

test("a reply nothing can be rescued from still fails, so the window is re-read", async () => {
  const { ctx } = scriptedContext([
    reply(candidate({ title: "One", type: "vibe" })),
    "I am not sure what you want here.",
  ]);

  await assert.rejects(
    () =>
      runCaptureModel(ctx, CONFIG, "transcript", { names: [] }, () => {}),
    /invalid type/u,
  );
});

test("a retry whose model call fails leaves the refusal to be reported", async () => {
  // One reply only: the second call finds the queue empty and answers with
  // nothing, which is the same shape as a retry that returned no text.
  const { ctx } = scriptedContext([
    reply(
      candidate({ title: "Good one" }),
      candidate({ title: "Bad one", type: "vibe" }),
    ),
    "",
  ]);

  const warnings: string[] = [];
  const drafts = await runCaptureModel(
    ctx,
    CONFIG,
    "transcript",
    { names: [] },
    (message) => warnings.push(message),
  );

  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["Good one"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"Bad one"/u);
});
