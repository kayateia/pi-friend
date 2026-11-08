/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCaptureModel } from "../../src/memory/capture-runner.ts";
import type { AutoCaptureConfig } from "../../src/memory/config.ts";
import { withTempDir } from "../helpers.ts";

const CONFIG = {
  enabled: true,
  everyTurns: 5,
  idleTimeoutMs: 600_000,
  maxCandidates: 3,
} as unknown as AutoCaptureConfig;

/** A context whose one nested call answers with `text` and the given stop reason. */
function captureContext(
  text: string,
  stopReason: string,
  usage = { input: 100, output: 20 },
): ExtensionContext {
  return {
    model: { provider: "test", id: "model-a" },
    modelRegistry: {
      streamSimple: () =>
        (async function* stream() {
          yield {
            type: "done" as const,
            message: {
              role: "assistant",
              content: text === "" ? [] : [{ type: "text" as const, text }],
              provider: "test",
              model: "model-a",
              responseModel: "model-a-2026",
              usage,
              stopReason,
            },
          };
        })(),
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
}

/** Runs the body with the diagnostic log pointed at a temp file. */
async function withCaptureLog(
  body: (logPath: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (directory) => {
    const logPath = path.join(directory, "debug.log");
    const previous = process.env.PI_FRIEND_DEBUG_LOG;
    process.env.PI_FRIEND_DEBUG_LOG = logPath;
    try {
      await body(logPath);
    } finally {
      if (previous === undefined) {
        delete process.env.PI_FRIEND_DEBUG_LOG;
      } else {
        process.env.PI_FRIEND_DEBUG_LOG = previous;
      }
    }
  });
}

test("a reply with no candidates array is logged verbatim with its stop reason", async () => {
  await withCaptureLog(async (logPath) => {
    const ctx = captureContext("I'm sorry, I can't help with that.", "stop");

    await assert.rejects(
      () => runCaptureModel(ctx, CONFIG, "transcript", { names: [] }, () => {}),
      /candidates array/,
    );

    const reply = "I'm sorry, I can't help with that.";
    const content = await readFile(logPath, "utf8");
    assert.match(content, /\[error capture response rejected\]/u);
    assert.match(content, /I'm sorry, I can't help with that\./u);
    assert.match(content, /stopReason: 'stop'/u);
    assert.match(content, /responseModel: 'model-a-2026'/u);
    assert.match(content, new RegExp(`textLength: ${reply.length}`, "u"));
  });
});

test("an empty reply is logged even though there is no text to show", async () => {
  await withCaptureLog(async (logPath) => {
    const ctx = captureContext("", "length");

    await assert.rejects(
      () => runCaptureModel(ctx, CONFIG, "transcript", { names: [] }, () => {}),
      /candidates array/,
    );

    const content = await readFile(logPath, "utf8");
    assert.match(content, /capture response rejected/u);
    assert.match(content, /stopReason: 'length'/u);
    assert.match(content, /textLength: 0/u);
  });
});

test("a parseable reply writes no rejection entry", async () => {
  await withCaptureLog(async (logPath) => {
    const ctx = captureContext('{"candidates":[]}', "stop");

    const drafts = await runCaptureModel(
      ctx,
      CONFIG,
      "transcript",
      { names: [] },
      () => {},
    );

    assert.deepEqual(drafts, []);
    await assert.rejects(() => readFile(logPath, "utf8"), /ENOENT/u);
  });
});
