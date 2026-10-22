/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  resolveDebugLogPath,
  writeDebugLog,
} from "../../src/debug/log.ts";
import { withTempDir } from "../helpers.ts";

test("debug logging writes to a private file and can be disabled", async () => {
  await withTempDir(async (directory) => {
    const logPath = path.join(directory, "debug.log");
    writeDebugLog("hook test", { value: 42 }, {
      enabled: true,
      logPath,
    });
    writeDebugLog("disabled", "not written", {
      enabled: false,
      logPath,
    });

    const content = await readFile(logPath, "utf8");
    assert.match(content, /\[hook test\]/);
    assert.match(content, /value: 42/);
    assert.doesNotMatch(content, /disabled/);
    assert.equal((await lstat(logPath)).mode & 0o777, 0o600);
  });
});

test("debug log path defaults under the Pi agent config directory", () => {
  assert.equal(
    resolveDebugLogPath({
      PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    }),
    "/tmp/pi-agent/pi-friend/debug.log",
  );
  assert.equal(
    resolveDebugLogPath({
      PI_FRIEND_DEBUG_LOG: "/tmp/custom-debug.log",
    }),
    "/tmp/custom-debug.log",
  );
});
