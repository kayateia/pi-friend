/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promptDebugLog } from "../src/debug-log.ts";

test("prompt diagnostics append to the shared debug log", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "prompt-debug-"));
  const logPath = path.join(directory, "debug.log");
  try {
    promptDebugLog(
      "web-ui prompt diagnostics",
      { overriddenByLaterHandler: true },
      {
        PI_FRIEND_DEBUG_HOOKS: "1",
        PI_FRIEND_DEBUG_LOG: logPath,
      },
    );
    const log = await readFile(logPath, "utf8");
    assert.match(log, /\[web-ui prompt diagnostics\]/);
    assert.match(log, /overriddenByLaterHandler: true/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
