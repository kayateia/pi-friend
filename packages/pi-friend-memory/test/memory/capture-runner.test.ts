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

test("a refused draft costs one candidate, and the rest of the pass completes", async () => {
  const { MemoryNodeRepository } = await import("../../src/memory/repository.ts");
  const { MemoryNodeService } = await import("../../src/memory/service.ts");
  const { stageCaptureDrafts } = await import("../../src/memory/capture-runner.ts");
  const { withTempDir } = await import("../helpers.ts");

  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const warnings: string[] = [];

    // The second draft's body is empty, which the service refuses; that refusal
    // is deterministic, so skipping it lets the pass finish and the cursor
    // advance — the alternative is re-reading the window and re-staging the
    // first draft as a near-duplicate.
    const result = await stageCaptureDrafts(
      service,
      [
        {
          title: "Kettle",
          type: "fact",
          body: "The kettle lives on the second shelf.",
          speaker: [{ name: "Aisling", confident: true }],
        },
        {
          title: "Empty",
          type: "fact",
          body: "   ",
          speaker: [],
        },
        {
          title: "Lantern",
          type: "fact",
          body: "The lantern hangs by the door.",
          speaker: [],
        },
      ],
      "session-test",
      (message) => warnings.push(message),
    );

    assert.equal(result.stored, 2);
    assert.deepEqual(result.rejected.map((entry) => entry.title), ["Empty"]);
    assert.match(warnings[0] ?? "", /could not store 1 of 3 candidates/u);
    assert.match(warnings[0] ?? "", /Empty/u);

    const staged = (await repository.list("staging")).map(
      (node) => node.frontMatter.title,
    );
    assert.deepEqual(staged.sort(), ["Kettle", "Lantern"]);
  });
});

test("an environmental failure still aborts the pass", async () => {
  const { stageCaptureDrafts } = await import("../../src/memory/capture-runner.ts");

  // A write failure is not a rejection: the draft was never judged, and
  // advancing past it would lose it silently.
  const service = {
    async stageCandidate() {
      throw new TypeError("disk went away");
    },
  } as unknown as Parameters<typeof stageCaptureDrafts>[0];

  await assert.rejects(
    () =>
      stageCaptureDrafts(
        service,
        [
          {
            title: "Kettle",
            type: "fact",
            body: "Body.",
            speaker: [],
          },
        ],
        "session-test",
        () => undefined,
      ),
    /disk went away/u,
  );
});
