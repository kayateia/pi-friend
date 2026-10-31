/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AutoCaptureScheduler } from "../../src/memory/capture-scheduler.ts";

test("capture scheduler runs on the settled-run threshold", async () => {
  let captures = 0;
  const scheduler = new AutoCaptureScheduler({
    everyTurns: 2,
    idleTimeoutMs: 50,
    isIdle: () => true,
    capture: async () => {
      captures += 1;
    },
  });
  try {
    await scheduler.onSettled();
    assert.equal(captures, 0);
    await scheduler.onSettled();
    assert.equal(captures, 1);
  } finally {
    scheduler.shutdown();
  }
});

test("capture scheduler runs only after post-settlement idle time", async () => {
  let captures = 0;
  let idle = true;
  const scheduler = new AutoCaptureScheduler({
    everyTurns: 10,
    idleTimeoutMs: 10,
    isIdle: () => idle,
    capture: async () => {
      captures += 1;
    },
  });
  try {
    await scheduler.onSettled();
    await delay(30);
    assert.equal(captures, 1);

    idle = false;
    await scheduler.onSettled();
    await delay(30);
    assert.equal(captures, 1);
  } finally {
    scheduler.shutdown();
  }
});

/** Waits for timer callbacks in scheduler tests. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
