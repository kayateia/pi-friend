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
import type { ParsedMemoryNode } from "../../src/memory/schema.ts";
import type { MemoryNodeService } from "../../src/memory/service.ts";
import { registerMemoryTools } from "../../src/tools/memory-tools.ts";

/** Registers the tools and returns the one named, with its execute. */
function tool(name: string, service: unknown): {
  execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
} {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  registerMemoryTools(pi, () => service as unknown as MemoryNodeService);
  return definitions.get(name) as {
    execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
  };
}

/** One node with tags, links and no edit history. */
function node(slug: string): ParsedMemoryNode {
  return {
    slug,
    body: "\nThe kettle is blue.\n",
    frontMatter: {
      title: "Kettle",
      type: "fact",
      speaker: [{ name: "Aria", confident: true }],
      agents: [],
      created: "2026-11-22T00:00:00.000Z",
      last_used: "2026-11-22T00:00:00.000Z",
      use_count: 0,
      decay_weight: 1,
      status: "active",
      emotional_flavour: "neutral",
      tags: ["kitchen", "kettle"],
      links: ["tea-routine"],
      sources: [],
    },
  };
}

test("a listing prints tags and links, and dates an unedited memory as created", async () => {
  const service = {
    async listCanonicalNodes() {
      return [node("kettle")];
    },
  };

  const result = await tool("memory_list", service).execute("call", {});

  const text = result.content[0]?.text ?? "";
  assert.match(text, /type: fact · created: 2026-11-22T00:00:00\.000Z/u);
  assert.match(text, /^tags: kitchen, kettle$/mu);
  assert.match(text, /^links: tea-routine$/mu);
  // Tags and links sit under the metadata line and above the attribution.
  assert.ok(
    text.indexOf("tags:") < text.indexOf("Heard from:"),
    "tags belong with the metadata, before the attribution",
  );
});

test("a search result prints tags and links before the why line", async () => {
  const service = {
    async recordUse() {},
    store: { config: { search: { defaultMode: "keyword" } } },
    canSearchSemantically: false,
    async search() {
      return [
        {
          relativePath: "nodes/kettle.md",
          kind: "node",
          slug: "kettle",
          title: "Kettle",
          type: "fact",
          status: "active",
          tags: ["kitchen", "kettle"],
          links: ["tea-routine"],
          snippet: "The kettle is blue.",
          score: 200,
          matchedFields: ["body"],
        },
      ];
    },
  };

  const result = await tool("memory_search", service).execute("call", {
    query: "kettle",
  });

  const text = result.content[0]?.text ?? "";
  assert.match(text, /^tags: kitchen, kettle$/mu);
  assert.match(text, /^links: tea-routine$/mu);
  assert.ok(
    text.indexOf("tags:") < text.indexOf("Why recalled:"),
    "metadata precedes the retrieval explanation",
  );
});
