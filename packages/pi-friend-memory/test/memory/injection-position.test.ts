/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  MemoryConfigError,
  parseMemoryConfig,
} from "../../src/memory/config.ts";

// A configuration problem that has a safe answer is a warning rather than a
// refusal: a position in front of the current turn names no user message that
// exists, and refusing to start costs more than injecting into the nearest one.

const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");

test("a positive injection position warns and is treated as zero", () => {
  const config = parseMemoryConfig(
    "memory:\n  injection:\n    position: 3\n",
    configPath,
  );

  assert.equal(config.injection.position, 0);
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0]!, /memory\.injection\.position/);
  assert.match(config.warnings[0]!, /treated as 0/);
});

test("a position that is not an integer is still refused", () => {
  for (const source of [
    "memory:\n  injection:\n    position: 1.5\n",
    "memory:\n  injection:\n    position: 'zero'\n",
  ]) {
    assert.throws(
      () => parseMemoryConfig(source, configPath),
      MemoryConfigError,
    );
  }
});

test("an omitted injection position defaults to one turn back", () => {
  const config = parseMemoryConfig(
    "memory:\n  injection:\n    enabled: true\n",
    configPath,
  );

  assert.equal(config.injection.position, -1);
  assert.deepEqual(config.warnings, []);
});
