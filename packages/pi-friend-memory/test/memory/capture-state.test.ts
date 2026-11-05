/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  captureStatePath,
  readCaptureState,
  writeCaptureState,
  type CaptureState,
} from "../../src/memory/capture-state.ts";
import { withTempDir } from "../helpers.ts";

const STATE: CaptureState = {
  version: 1,
  sessionId: "session-1",
  lastEntryId: "entry-7",
  lastCapturedAt: "2026-11-05T04:00:00.000Z",
};

test("capture state survives a round trip", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "nested", "capture-state.json");
    assert.deepEqual(await readCaptureState(filePath), {});

    await writeCaptureState(filePath, STATE);
    assert.deepEqual(await readCaptureState(filePath), { state: STATE });
  });
});

test("writing capture state replaces the previous cursor", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeCaptureState(filePath, STATE);
    const next = { ...STATE, lastEntryId: "entry-9" };
    await writeCaptureState(filePath, next);

    assert.deepEqual(await readCaptureState(filePath), { state: next });
    assert.deepEqual(await readdir(directory), ["capture-state.json"]);
  });
});

test("a missing state file is not a warning", async () => {
  await withTempDir(async (directory) => {
    assert.deepEqual(
      await readCaptureState(path.join(directory, "absent.json")),
      {},
    );
  });
});

test("unusable state files warn instead of passing as a fresh session", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    const cases: Array<[string, RegExp]> = [
      ["not json", /not valid JSON/u],
      ["[1,2,3]", /not a JSON object/u],
      [JSON.stringify({ ...STATE, version: 2 }), /version 2/u],
      [JSON.stringify({ ...STATE, lastEntryId: "" }), /missing sessionId/u],
      [
        JSON.stringify({ version: 1, sessionId: "s" }),
        /missing sessionId/u,
      ],
    ];
    for (const [source, expected] of cases) {
      await writeFile(filePath, source, "utf8");
      const result = await readCaptureState(filePath);
      assert.equal(result.state, undefined, source);
      assert.match(result.warning ?? "", expected, source);
    }
  });
});

test("the state path sits beside the extension config, not in the store", () => {
  assert.equal(
    captureStatePath("/agent"),
    path.join("/agent", "pi-friend", "memory", "capture-state.json"),
  );
});
