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

test("the example configuration matches supported defaults", async () => {
  const examplePath = path.resolve("pi-friend.example.yml");
  const config = parseMemoryConfig(
    await readFile(examplePath, "utf8"),
    path.join("/tmp", "pi-friend.yml"),
    "/Users/example",
  );

  assert.equal(config.root, "/Users/example/.pi/agent/pi-friend/memory");
  assert.equal(config.injection.enabled, true);
  assert.equal(config.injection.position, -1);
  assert.equal(config.injection.mode, "hybrid");
  assert.equal(config.injection.daily.days, 2);
  assert.equal(config.autoCapture.everyTurns, 5);
  assert.equal(config.sweep.tombstoneGraceDays, 30);
  assert.equal(config.sweep.minGuardedBatchSize, 10);
  assert.equal(config.dreaming.maxNodes, 4);
});
