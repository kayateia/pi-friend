/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  captureStatePath,
  cursorBelongsToHost,
  readCaptureCursor,
  resolveHostIdentity,
  stampCaptureHost,
  writeCaptureCursor,
} from "../../src/memory/capture-state.ts";
import { withTempDir } from "../helpers.ts";

const CAPTURED_AT = new Date("2026-11-05T04:00:00.000Z");

/** One completed capture, as the extension writes it. */
const CAPTURE = { lastEntryId: "entry-7", modifiedAt: CAPTURED_AT.toISOString() };

test("each session keeps its own cursor", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "nested", "capture-state.json");
    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {});

    await writeCaptureCursor(
      filePath,
      "session-a",
      { lastEntryId: "entry-7" },
      CAPTURED_AT,
    );
    await writeCaptureCursor(
      filePath,
      "session-b",
      { lastEntryId: "entry-2", host: "val" },
      CAPTURED_AT,
    );

    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: CAPTURE,
    });
    assert.deepEqual(await readCaptureCursor(filePath, "session-b"), {
      cursor: { ...CAPTURE, lastEntryId: "entry-2", host: "val" },
    });
    assert.deepEqual(await readCaptureCursor(filePath, "session-c"), {});
  });
});

test("writing one session does not disturb another", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeCaptureCursor(
      filePath,
      "session-a",
      { lastEntryId: "entry-7" },
      CAPTURED_AT,
    );
    await writeCaptureCursor(
      filePath,
      "session-a",
      { lastEntryId: "entry-9" },
      CAPTURED_AT,
    );

    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: { ...CAPTURE, lastEntryId: "entry-9" },
    });
    assert.deepEqual(await readdir(directory), ["capture-state.json"]);
  });
});

test("concurrent writes for different sessions all survive", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await Promise.all(
      ["one", "two", "three", "four", "five"].map((session, index) =>
        writeCaptureCursor(
          filePath,
          session,
          { lastEntryId: `entry-${index}` },
          CAPTURED_AT,
        ),
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
        cursor: { ...CAPTURE, lastEntryId: `entry-${index}` },
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
        modifiedAt: "2026-11-05T01:40:00.000Z",
      },
    });
    assert.deepEqual(await readCaptureCursor(filePath, "other-session"), {});
  });
});

test("a version 2 file keeps its cursors and gains no owner", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        sessions: {
          "old-session": {
            lastEntryId: "entry-3",
            lastCapturedAt: "2026-11-05T01:40:00.000Z",
          },
        },
      }),
      "utf8",
    );

    // The capture time becomes the record's, so the ageing rule still applies.
    assert.deepEqual(await readCaptureCursor(filePath, "old-session"), {
      cursor: {
        lastEntryId: "entry-3",
        modifiedAt: "2026-11-05T01:40:00.000Z",
      },
    });
  });
});

test("stamping a host creates a record for a session nothing has captured", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");

    assert.equal(await stampCaptureHost(filePath, "session-a", "val", CAPTURED_AT), true);

    // No position: ownership exists before the first capture does.
    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: { host: "val", modifiedAt: CAPTURED_AT.toISOString() },
    });
  });
});

test("stamping a host keeps the position the session already has", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeCaptureCursor(
      filePath,
      "session-a",
      { lastEntryId: "entry-7", host: "weiss" },
      CAPTURED_AT,
    );

    const later = new Date("2026-11-05T05:00:00.000Z");
    assert.equal(await stampCaptureHost(filePath, "session-a", "val", later), true);
    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: {
        host: "val",
        lastEntryId: "entry-7",
        modifiedAt: later.toISOString(),
      },
    });
  });
});

test("stamping the host that already owns the session writes nothing", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await stampCaptureHost(filePath, "session-a", "val", CAPTURED_AT);
    const before = await readFile(filePath, "utf8");

    const later = new Date("2026-11-05T05:00:00.000Z");
    assert.equal(await stampCaptureHost(filePath, "session-a", "val", later), false);
    assert.equal(await readFile(filePath, "utf8"), before);
  });
});

test("ownership is compared without regard to case", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await stampCaptureHost(filePath, "session-a", "Val", CAPTURED_AT);

    assert.equal(
      await stampCaptureHost(filePath, "session-a", "val", CAPTURED_AT),
      false,
    );
    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: { host: "Val", modifiedAt: CAPTURED_AT.toISOString() },
    });
  });
});

test("stamping with no identity writes nothing", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");

    assert.equal(await stampCaptureHost(filePath, "session-a", "  ", CAPTURED_AT), false);
    // No file, no record: a machine with no name of its own does not claim
    // sessions, and must not create one that says nothing about them.
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {});
  });
});

test("stale records are pruned when anything is written", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await writeCaptureCursor(
      filePath,
      "old",
      { lastEntryId: "entry-1" },
      new Date("2026-10-01T00:00:00.000Z"),
    );
    await stampCaptureHost(
      filePath,
      "fresh",
      "val",
      new Date("2026-11-05T06:00:00.000Z"),
    );

    assert.deepEqual(await readCaptureCursor(filePath, "old"), {});
    assert.deepEqual(await readCaptureCursor(filePath, "fresh"), {
      cursor: { host: "val", modifiedAt: "2026-11-05T06:00:00.000Z" },
    });
  });
});

test("a stored owner outlives the capture that wrote it", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "capture-state.json");
    await stampCaptureHost(filePath, "session-a", "val", CAPTURED_AT);
    await writeCaptureCursor(
      filePath,
      "session-a",
      { lastEntryId: "entry-9" },
      CAPTURED_AT,
    );

    assert.deepEqual(await readCaptureCursor(filePath, "session-a"), {
      cursor: { host: "val", lastEntryId: "entry-9", modifiedAt: CAPTURED_AT.toISOString() },
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
        JSON.stringify({ version: 3, sessions: { a: { lastEntryId: "" } } }),
        /1 unusable session entry/u,
      ],
      [
        JSON.stringify({ version: 3, sessions: { a: { modifiedAt: "2026-11-05T00:00:00.000Z" } } }),
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

test("a session belongs to the host that last spoke in it", () => {
  const owned = { host: "val", lastEntryId: "entry-7", modifiedAt: CAPTURED_AT.toISOString() };

  assert.equal(cursorBelongsToHost(owned, "val"), true);
  assert.equal(cursorBelongsToHost(owned, "weiss"), false);
  // A machine with no identity of its own keeps the old behaviour everywhere.
  assert.equal(cursorBelongsToHost(owned, undefined), true);
  // So does a record written before owners were recorded, and a session that
  // has no record at all.
  assert.equal(cursorBelongsToHost({ ...owned, host: undefined }, "weiss"), true);
  assert.equal(cursorBelongsToHost(undefined, "weiss"), true);
  // Host names are typed by a person into each machine's environment.
  assert.equal(cursorBelongsToHost({ ...owned, host: "Val" }, "val"), true);
});

test("a host identity is read from the environment, trimmed, and optional", () => {
  assert.equal(resolveHostIdentity({ HOST_IDENTITY: "  val  " }), "val");
  assert.equal(resolveHostIdentity({ HOST_IDENTITY: "   " }), undefined);
  assert.equal(resolveHostIdentity({}), undefined);
});

test("the state path sits beside the extension config, not in the store", () => {
  assert.equal(
    captureStatePath("/agent"),
    path.join("/agent", "pi-friend", "memory", "capture-state.json"),
  );
});
