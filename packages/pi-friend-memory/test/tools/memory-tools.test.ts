/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatMemoryToolName,
  registerMemoryTools,
} from "../../src/tools/memory-tools.ts";

test("memory tool names use a configurable prefix without duplication", () => {
  assert.equal(formatMemoryToolName("", "memory_add"), "memory_add");
  assert.equal(formatMemoryToolName("pf_", "memory_add"), "pf_memory_add");
});

test("manual index path is not registered as a memory tool", () => {
  const names: string[] = [];
  const pi = {
    registerTool(definition: { name: string }) {
      names.push(definition.name);
    },
  } as unknown as ExtensionAPI;

  registerMemoryTools(pi, () => undefined);

  assert.equal(names.includes("memory_index_path"), false);
  assert.equal(names.includes("memory_search"), true);
});
