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
    store: { config: { search: { defaultMode: "keyword" } } },
    canSearchSemantically: true,
    async search(options: unknown) {
      captured.push(options);
      return [];
    },
  };

  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);

  const definition = definitions.get("memory_search") as {
    parameters: { properties: Record<string, unknown> };
    execute: (id: string, params: unknown) => Promise<unknown>;
  };
  assert.ok("corpus" in definition.parameters.properties);

  await definition.execute("call", { query: "harbour", corpus: "documents" });
  assert.deepEqual(captured.at(-1), {
    query: "harbour",
    mode: undefined,
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

test("an unavailable configured default degrades to keyword with a note", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const stubService = {
    store: { config: { search: { defaultMode: "hybrid" } } },
    canSearchSemantically: false,
    async search(options: Record<string, unknown>) {
      captured.push(options);
      return [];
    },
  };

  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);
  const definition = definitions.get("memory_search") as {
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
  };

  // Inherited default: degrade, and say why.
  const degraded = await definition.execute("call", { query: "harbour" });
  assert.equal(captured.at(-1)?.mode, "keyword");
  assert.match(degraded.content[0]?.text ?? "", /no embedding provider is available/);

  // Explicit request: fail rather than silently downgrade.
  await definition.execute("call", { query: "harbour", mode: "semantic" });
  assert.equal(captured.at(-1)?.mode, "semantic");
});

test("memory_search prints speaker attribution when present", async () => {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const stubService = {
    store: { config: { search: { defaultMode: "keyword" } } },
    canSearchSemantically: true,
    async search() {
      return [
        {
          relativePath: "nodes/attributed.md",
          kind: "node",
          slug: "attributed",
          title: "Attributed",
          type: "fact",
          status: "active",
          tags: [],
          body: "Something Aria said.",
          snippet: "Something Aria said.",
          score: 200,
          matchedFields: ["body"],
          speaker: [
            { name: "Aria", confident: true },
            { name: "Iri", confident: false, note: "relayed" },
          ],
        },
      ];
    },
  };

  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);
  const definition = definitions.get("memory_search") as {
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
  };

  const result = await definition.execute("call", { query: "something" });
  assert.match(
    result.content[0]?.text ?? "",
    /Heard from: Aria; Iri \(uncertain\) — relayed/,
  );
});

test("memory_merge passes the target, sources and optional body through", async () => {
  const calls: unknown[] = [];
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const stubService = {
    async mergeCandidates(target: string, sources: string[], options: unknown) {
      calls.push({ target, sources, options });
      return {
        node: { slug: target },
        mergedInto: target,
        removedMemories: sources,
        removedCandidates: [],
        rewritten: options !== undefined,
        bodySupplied: (options as { body?: string }).body !== undefined,
      };
    },
  };
  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);

  const definition = definitions.get("memory_merge") as {
    parameters: { properties: Record<string, unknown> };
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{ content: { text: string }[]; details: unknown }>;
  };
  assert.ok("target" in definition.parameters.properties);
  assert.ok("sources" in definition.parameters.properties);
  assert.ok("body" in definition.parameters.properties);

  const result = await definition.execute("call", {
    target: "house-rules",
    sources: ["old-rules", "staged-rule"],
    body: "Consolidated rules.",
  });
  assert.deepEqual(calls.at(-1), {
    target: "house-rules",
    sources: ["old-rules", "staged-rule"],
    options: { body: "Consolidated rules." },
  });
  assert.match(result.content[0]?.text ?? "", /into "house-rules"/);
  assert.equal(
    (result.details as { removedMemories: string[] }).removedMemories.length,
    2,
  );
});
