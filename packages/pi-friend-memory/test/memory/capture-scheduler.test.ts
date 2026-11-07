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

test("background capture failures are reported", async () => {
  const reported: Array<{ label: string; error: unknown }> = [];
  const scheduler = new AutoCaptureScheduler({
    everyTurns: 10,
    idleTimeoutMs: 10,
    isIdle: () => true,
    capture: async () => {
      throw new Error("capture backend unavailable");
    },
    reportError: (label, error) => reported.push({ label, error }),
  });
  try {
    await scheduler.onSettled();
    await delay(30);
    assert.equal(reported[0]?.label, "auto-capture scheduler");
    assert.match(String(reported[0]?.error), /capture backend unavailable/u);
  } finally {
    scheduler.shutdown();
  }
});

test("a loaded session with pending material captures without a new settle", async () => {
  let captures = 0;
  const scheduler = new AutoCaptureScheduler({
    everyTurns: 10,
    idleTimeoutMs: 10,
    isIdle: () => true,
    capture: async () => {
      captures += 1;
    },
  });
  try {
    // No settlement arrives: this is a session reopened after a restart.
    scheduler.armIdleCapture();
    await delay(30);
    assert.equal(captures, 1);
  } finally {
    scheduler.shutdown();
  }
});

test("shutdown cancels an armed capture for a loaded session", async () => {
  let captures = 0;
  const scheduler = new AutoCaptureScheduler({
    everyTurns: 10,
    idleTimeoutMs: 10,
    isIdle: () => true,
    capture: async () => {
      captures += 1;
    },
  });
  scheduler.armIdleCapture();
  scheduler.shutdown();
  await delay(30);
  assert.equal(captures, 0);
});

test("arming again replaces the pending timer rather than adding one", async () => {
  let captures = 0;
  const scheduler = new AutoCaptureScheduler({
    everyTurns: 10,
    idleTimeoutMs: 20,
    isIdle: () => true,
    capture: async () => {
      captures += 1;
    },
  });
  try {
    scheduler.armIdleCapture();
    await delay(10);
    scheduler.armIdleCapture();
    await delay(30);
    // One capture: the first arm's timer was cancelled, not left to fire.
    assert.equal(captures, 1);
  } finally {
    scheduler.shutdown();
  }
});

/** Waits for timer callbacks in scheduler tests. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
