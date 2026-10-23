/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatMemoryToolName } from "../../src/tools/memory-tools.ts";

test("memory tool names use a configurable prefix without duplication", () => {
  assert.equal(formatMemoryToolName("", "memory_add"), "memory_add");
  assert.equal(formatMemoryToolName("pf_", "memory_add"), "pf_memory_add");
});
