/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 *
 * Points the diagnostic log at a throwaway file for the whole test run.
 *
 * Production code logs through `logError` on paths that tests exercise on
 * purpose — a merge writer failing, a model call being retried — and without
 * this they resolve to the live `~/.pi/pi-friend/debug.log`, so a test run leaves
 * fixture stack traces in the file a person reads for real failures. The test
 * output already says what happened; the log should stay quiet.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const logPath = path.join(tmpdir(), `pi-friend-test-${process.pid}.log`);
process.env.PI_FRIEND_DEBUG_LOG = logPath;

process.on("exit", () => {
  try {
    unlinkSync(logPath);
  } catch {
    // Nothing written, or already gone; either way there is nothing to clean.
  }
});
