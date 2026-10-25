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
import { parseMemoryConfig } from "../../src/memory/config.ts";
import { CAPTURE_SYSTEM_PROMPT } from "../../src/memory/capture.ts";
import { DREAM_SYSTEM_PROMPT } from "../../src/memory/dream.ts";
import { SWEEP_SYSTEM_PROMPT } from "../../src/memory/sweep-model.ts";

test("the example configuration matches supported defaults", async () => {
  const examplePath = path.resolve("pi-friend.example.yml");
  const config = parseMemoryConfig(
    await readFile(examplePath, "utf8"),
    path.join("/tmp", "pi-friend.yml"),
    "/Users/example",
  );

  assert.equal(config.root, "/Users/example/.pi/agent/pi-friend/memory");
  assert.equal(config.toolPrefix, "");
  assert.equal(config.injection.enabled, true);
  assert.equal(config.injection.position, -1);
  assert.equal(config.injection.mode, "hybrid");
  assert.equal(config.autoCapture.everyTurns, 5);
  assert.equal(config.autoCapture.prompt, CAPTURE_SYSTEM_PROMPT);
  assert.equal(config.sweep.tombstoneGraceDays, 30);
  assert.equal(config.sweep.minGuardedBatchSize, 10);
  assert.equal(config.sweep.background, false);
  assert.equal(config.sweep.prompt, SWEEP_SYSTEM_PROMPT);
  assert.equal(config.dreaming.maxNodes, 4);
  assert.equal(config.dreaming.prompt, DREAM_SYSTEM_PROMPT);
  assert.equal(config.vector.chunkSize, 4_000);
});
