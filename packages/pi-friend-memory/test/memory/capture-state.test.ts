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
  readCaptureCursor,
  writeCaptureCursor,
  type CaptureCursor,
} from "../../src/memory/capture-state.ts";
import { withTempDir } from "../helpers.ts";

const CURSOR: CaptureCursor = {
  lastEntryId: "entry-7",
  lastCapturedAt: "2026-11-05T04:00:00.000Z",
};

test("each session keeps its own cursor", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "nested", "capture-state.json");
    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {});

    await writeCaptureCursor(filePath, "session-a", CURSOR);
    await writeCaptureCursor(filePath, "session-b", {
      lastEntryId: "entry-2",
      lastCapturedAt: "2026-11-05T05:00:00.000Z",
    });

    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: CURSOR,
    });
    assert.deepEqual(await readCaptureCursor(filePath, "session-b"), {
      cursor: {
        lastEntryId: "entry-2",
        lastCapturedAt: "2026-11-05T05:00:00.000Z",
      },
    });
    assert.deepEqual(await readCaptureCursor(filePath, "session-c"), {});
  });
});

test("writing one session does not disturb another", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeCaptureCursor(filePath, "session-a", CURSOR);
    await writeCaptureCursor(filePath, "session-a", {
      ...CURSOR,
      lastEntryId: "entry-9",
    });

    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: { ...CURSOR, lastEntryId: "entry-9" },
    });
    assert.deepEqual(await readdir(directory), ["capture-state.json"]);
  });
});

test("concurrent writes for different sessions all survive", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await Promise.all(
      ["one", "two", "three", "four", "five"].map((session, index) =>
        writeCaptureCursor(filePath, session, {
          lastEntryId: `entry-${index}`,
          lastCapturedAt: "2026-11-05T04:00:00.000Z",
        }),
      ),
    );

    for (const [index, session] of [
      "one",
      "two",
      "three",
      "four",
      "five",
    ].entries()) {
      assert.deepEqual(await readCaptureCursor(filePath, session), {
        cursor: {
          lastEntryId: `entry-${index}`,
          lastCapturedAt: "2026-11-05T04:00:00.000Z",
        },
      });
    }
  });
});

test("a version 1 file is read as the session it recorded", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        sessionId: "old-session",
        lastEntryId: "entry-3",
        lastCapturedAt: "2026-11-05T01:40:00.000Z",
      }),
      "utf8",
    );

    assert.deepEqual(await readCaptureCursor(filePath, "old-session"), {
      cursor: {
        lastEntryId: "entry-3",
        lastCapturedAt: "2026-11-05T01:40:00.000Z",
      },
    });
    assert.deepEqual(await readCaptureCursor(filePath, "other-session"), {});
  });
});

test("stale sessions are pruned when a cursor is written", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeCaptureCursor(filePath, "old", {
      lastEntryId: "entry-1",
      lastCapturedAt: "2026-10-01T00:00:00.000Z",
    });
    await writeCaptureCursor(
      filePath,
      "fresh",
      CURSOR,
      new Date("2026-11-05T06:00:00.000Z"),
    );

    assert.deepEqual(await readCaptureCursor(filePath, "old"), {});
    assert.deepEqual(await readCaptureCursor(filePath, "fresh"), {
      cursor: CURSOR,
    });
  });
});

test("unusable state files warn instead of passing as a fresh session", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    const cases: Array<[string, RegExp]> = [
      ["not json", /not valid JSON/u],
      ["[1,2,3]", /not a JSON object/u],
      [JSON.stringify({ version: 99 }), /version 99/u],
      [JSON.stringify({ version: 1, sessionId: "" }), /unusable version 1/u],
      [
        JSON.stringify({ version: 2, sessions: { a: { lastEntryId: "" } } }),
        /1 unusable session entry/u,
      ],
    ];
    for (const [source, expected] of cases) {
      await writeFile(filePath, source, "utf8");
      const result = await readCaptureCursor(filePath, "session-a");
      assert.equal(result.cursor, undefined, source);
      assert.match(result.warning ?? "", expected, source);
    }
  });
});

test("a missing state file is not a warning", async () => {
  await withTempDir(async (directory) => {
    assert.deepEqual(
      await readCaptureCursor(path.join(directory, "absent.json"), "session-a"),
      {},
    );
  });
});

test("the state path sits beside the extension config, not in the store", () => {
  assert.equal(
    captureStatePath("/agent"),
    path.join("/agent", "pi-friend", "memory", "capture-state.json"),
  );
});
