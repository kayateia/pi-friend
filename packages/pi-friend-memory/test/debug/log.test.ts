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
  formatErrorChain,
  formatErrorDetails,
  logError,
  logNotice,
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

test("error formatting includes nested causes and stacks", () => {
  const root = new Error("no such module: vec0");
  const wrapped = new Error("Could not initialize sqlite-vec index.", {
    cause: root,
  });

  assert.equal(
    formatErrorChain(wrapped),
    "Error: Could not initialize sqlite-vec index.; caused by Error: no such module: vec0",
  );
  const details = formatErrorDetails(wrapped);
  assert.match(details, /\[Error\] Error: Could not initialize sqlite-vec index\./u);
  assert.match(details, /\[Caused by 1\] Error: no such module: vec0/u);
  assert.match(details, /at /u);
});

test("operational errors are persisted when debug logging is disabled", async () => {
  await withTempDir(async (directory) => {
    const logPath = path.join(directory, "debug.log");
    const error = new Error("outer failure", {
      cause: new Error("sqlite extension failed"),
    });

    logError("semantic index unavailable", error, {
      logPath,
      dedupeMs: 0,
      now: 1,
    });
    logError("semantic index unavailable", error, {
      logPath,
      dedupeMs: 60_000,
      now: 2,
    });

    const content = await readFile(logPath, "utf8");
    assert.match(content, /\[error semantic index unavailable\]/u);
    assert.match(content, /outer failure/u);
    assert.match(content, /sqlite extension failed/u);
    assert.equal(content.match(/\[error semantic index unavailable\]/gu)?.length, 1);
    assert.equal((await lstat(logPath)).mode & 0o777, 0o600);
  });
});

test("error logging deduplicates identical failures for a short interval", async () => {
  await withTempDir(async (directory) => {
    const logPath = path.join(directory, "debug.log");
    const first = new Error("repeat me");
    const second = new Error("repeat me");

    logError("watcher", first, { logPath, now: 100, dedupeMs: 50 });
    logError("watcher", second, { logPath, now: 120, dedupeMs: 50 });
    logError("watcher", second, { logPath, now: 151, dedupeMs: 50 });

    const content = await readFile(logPath, "utf8");
    assert.equal(content.match(/\[error watcher\]/gu)?.length, 2);
  });
});

test("a warning reaches the log even when debug logging is off", async () => {
  await withTempDir(async (directory) => {
    const logPath = path.join(directory, "debug.log");

    // Warnings are shown as toasts, and a toast is gone in seconds — on some
    // front ends before it has been read. The log line is what is left.
    logNotice("warning", "pi-friend memory sweep removed 39 of 90 staged candidates", {
      logPath,
      env: {},
    });

    const content = await readFile(logPath, "utf8");
    assert.match(content, /\[warning\]/u);
    assert.match(content, /39 of 90/u);
    assert.equal((await lstat(logPath)).mode & 0o777, 0o600);
  });
});
