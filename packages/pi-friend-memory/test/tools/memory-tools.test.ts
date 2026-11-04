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
import type { MemoryNodeService } from "../../src/memory/service.ts";
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

test("memory_search exposes corpus and passes it through", async () => {
  const captured: unknown[] = [];
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const stubService = {
    async search(options: unknown) {
      captured.push(options);
      return [];
    },
  };

  registerMemoryTools(
    pi,
    () => stubService as unknown as MemoryNodeService,
  );

  const definition = definitions.get("memory_search") as {
    parameters: { properties: Record<string, unknown> };
    execute: (id: string, params: unknown) => Promise<unknown>;
  };
  assert.ok("corpus" in definition.parameters.properties);

  await definition.execute("call", { query: "harbour", corpus: "documents" });
  assert.deepEqual(captured.at(-1), {
    query: "harbour",
    mode: "keyword",
    type: undefined,
    corpus: "documents",
    limit: undefined,
  });

  await assert.rejects(
    async () =>
      definition.execute("call", {
        query: "harbour",
        corpus: "documents",
        type: "fact",
      }),
    /cannot be combined with corpus/,
  );
});
