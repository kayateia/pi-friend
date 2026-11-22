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
  registerMemoryCommands,
  registerMemoryTools,
} from "../../src/tools/memory-tools.ts";
import type { RagRetrievalDiagnostics } from "../../src/memory/rag.ts";
import { MEMORY_TYPES } from "../../src/memory/schema.ts";

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
    // Only the methods a given test reaches are meaningful here.
    async recordUse() {},
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
    // Only the methods a given test reaches are meaningful here.
    async recordUse() {},
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
    // Only the methods a given test reaches are meaningful here.
    async recordUse() {},
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
    // Only the methods a given test reaches are meaningful here.
    async recordUse() {},
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

test("speaker and agents are described as different kinds of participant", () => {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  registerMemoryTools(pi, () => undefined);

  type Schema = { description?: string; items?: Schema; properties?: Record<string, Schema> };
  const fields = (name: string): Record<string, Schema> => {
    const definition = definitions.get(name) as { parameters: Schema };
    return definition.parameters.properties ?? {};
  };

  for (const name of ["memory_add", "memory_edit"]) {
    const speaker = fields(name).speaker ?? {};
    const nameField = speaker.items?.properties?.name;
    const confident = speaker.items?.properties?.confident;
    // `speaker` names people; an AI goes in `agents`. The old wording said
    // "person or system", and in a plural system "system member" is a human,
    // which is what led an agent to record itself as a speaker.
    assert.match(nameField?.description ?? "", /non-AI entity/u);
    assert.match(nameField?.description ?? "", /Never an AI agent/u);
    assert.match(confident?.description ?? "", /first-hand|inferred/u);
    assert.match(fields(name).agents?.description ?? "", /AI agents involved in the exchange/u);
  }
});

test("memory_last_rag reports the last retrieval, or says there has been none", async () => {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;

  type Retrieval = ReturnType<
    NonNullable<Parameters<typeof registerMemoryTools>[3]>
  >;
  let last: Retrieval = undefined;
  registerMemoryTools(pi, () => undefined, "", () => last);

  const definition = definitions.get("memory_last_rag") as {
    execute: () => Promise<{ content: Array<{ text: string }> }>;
  };
  assert.ok(definition);
  assert.match((await definition.execute()).content[0]?.text ?? "", /has run in this session yet/u);

  last = {
    at: "2026-11-08T00:00:00.000Z",
    diagnostics: {
      query: "kettle",
      mode: "keyword",
      modeUsed: "keyword",
      fallbackUsed: false,
      results: [
        {
          slug: "kettle-boils",
          relativePath: "nodes/kettle-boils.md",
          kind: "node",
          score: 1150,
          keywordScore: 1150,
          keywordContributions: [{ field: "title", points: 900 }],
          matchedFields: ["title", "body"],
          injected: true,
        },
      ],
      searchResultCount: 1,
      eligibleNodeCount: 1,
      selectedNodeCount: 1,
    },
  };
  const text = (await definition.execute()).content[0]?.text ?? "";
  assert.match(text, /query: "kettle"/u);
  assert.match(text, /INJECTED {2}kettle-boils/u);
  assert.match(text, /points: title 900/u);
});

test("the last-rag command reports without a model call", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;

  let last: { diagnostics: RagRetrievalDiagnostics; at: string } | undefined;
  registerMemoryCommands(pi, () => last);

  const command = commands.get("memory-last-rag");
  assert.ok(command);

  const notices: string[] = [];
  const ctx = { ui: { notify: (message: string) => notices.push(message) } };

  await command.handler("", ctx);
  assert.match(notices[0] ?? "", /no retrieval has run in this session yet/u);

  last = {
    at: "2026-11-08T00:00:00.000Z",
    diagnostics: {
      query: "kettle",
      mode: "hybrid",
      modeUsed: "keyword",
      fallbackUsed: true,
      results: [],
      searchResultCount: 0,
      eligibleNodeCount: 0,
      selectedNodeCount: 0,
    },
  };
  await command.handler("", ctx);
  assert.match(notices[1] ?? "", /mode: keyword \(fell back from hybrid\)/u);
});

test("a query is required, and a date window filters the search", async () => {
  const searched: Array<Record<string, unknown>> = [];
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const stubService = {
    // Only the methods a given test reaches are meaningful here.
    async recordUse() {},
    store: { config: { search: { defaultMode: "keyword" } } },
    canSearchSemantically: true,
    async search(options: Record<string, unknown>) {
      searched.push(options);
      return [];
    },
  };
  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);
  const definition = definitions.get("memory_search") as {
    parameters: {
      properties: Record<string, unknown>;
      required?: readonly string[];
    };
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>;
  };

  // Searching is the only thing this tool does, so it always needs something
  // to search for; listing is a separate tool with its own parameters.
  assert.deepEqual(definition.parameters.required, ["query"]);
  assert.ok("since" in definition.parameters.properties);
  assert.ok("until" in definition.parameters.properties);

  // A date filter implies the memory corpus, and says so in the output.
  const dated = await definition.execute("call", {
    query: "kettle",
    since: "2026-11-01",
  });
  assert.equal(searched.at(-1)?.query, "kettle");
  assert.equal(searched.at(-1)?.corpus, "memory");
  assert.match(String(searched.at(-1)?.since), /^2026-11-01T/u);
  assert.match(dated.content[0]?.text ?? "", /corpus is memory/u);

  // Documents are dated by file modification time, so a date filter cannot
  // silently narrow a corpus the caller asked for by name.
  await assert.rejects(
    async () =>
      definition.execute("call", {
        query: "kettle",
        since: "2026-11-01",
        corpus: "documents",
      }),
    /apply to memories only/u,
  );
  await assert.rejects(
    async () =>
      definition.execute("call", {
        query: "kettle",
        since: "2026-11-08",
        until: "2026-11-01",
      }),
    /later than until/u,
  );
});

test("a request above the result cap says how many were returned", async () => {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const stubService = {
    // Only the methods a given test reaches are meaningful here.
    async recordUse() {},
    store: { config: { search: { defaultMode: "keyword" } } },
    canSearchSemantically: true,
    async search() {
      return [];
    },
  };
  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);
  const definition = definitions.get("memory_search") as {
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>;
  };

  const response = await definition.execute("call", {
    query: "kettle",
    limit: 40,
  });
  assert.match(response.content[0]?.text ?? "", /Showing 25 of the 40 requested/u);

  const quiet = await definition.execute("call", { query: "kettle", limit: 5 });
  assert.doesNotMatch(quiet.content[0]?.text ?? "", /Showing/u);
});

test("the tools that can set emotional_flavour offer examples of it", () => {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  registerMemoryTools(pi, () => undefined);

  // The field is free text, so the only thing that steers it is the vocabulary
  // a caller is shown. A description without examples is how the store ended up
  // almost entirely `neutral`.
  for (const name of ["memory_add", "memory_edit"]) {
    const definition = definitions.get(name) as {
      parameters: { properties: Record<string, unknown> };
    };
    const schema = JSON.stringify(
      definition.parameters.properties.emotional_flavour ?? {},
    );
    assert.match(schema, /Free-form/u);
    for (const example of [
      "warm",
      "matter-of-fact",
      "playful",
      "introspective",
      "prickly",
      "sore",
      "funny",
    ]) {
      assert.match(schema, new RegExp(example, "u"), `${name} lists ${example}`);
    }
  }
});

test("the validate command names the files that do not parse", async () => {
  const { MemoryNodeRepository } = await import("../../src/memory/repository.ts");
  const { withTempDir } = await import("../helpers.ts");

  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await repository.store.writeTextFile(
      "nodes/broken.md",
      `---
title: broken
type: recollection
speaker: []
agents: []
created: 2026-10-01T00:00:00Z
last_used: 2026-10-01T00:00:00Z
use_count: 0
decay_weight: 1
status: active
emotional_flavour: warm
tags: []
links: []
source: ""
---

Body.
`,
    );

    const commands = new Map<
      string,
      { handler: (args: string, ctx: unknown) => Promise<void> }
    >();
    const pi = {
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition);
      },
    } as unknown as ExtensionAPI;

    // Only the store is needed; the command reads files, not memory operations.
    registerMemoryCommands(pi, () => undefined, "", () => ({
      store: repository.store,
    }) as unknown as MemoryNodeService);

    const command = commands.get("memory-validate");
    assert.ok(command);

    const notices: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify: (message: string, level: string) =>
          notices.push({ message, level }),
      },
    };

    await command.handler("", ctx);
    assert.equal(notices[0]?.level, "warning");
    assert.match(notices[0]?.message ?? "", /1 file checked, 1 could not be parsed/u);
    assert.match(notices[0]?.message ?? "", /nodes\/broken\.md/u);
    assert.match(notices[0]?.message ?? "", /type/u);
  });
});

// ---- memory_list -----------------------------------------------------------

function listNode(options: {
  slug: string;
  title?: string;
  type?: "dream" | "fact" | "preference" | "event" | "person-note";
  body: string;
  created?: string;
  edited?: string;
  speaker?: Array<{ name: string; confident: boolean; note?: string }>;
  agents?: string[];
}) {
  return {
    slug: options.slug,
    body: `\n${options.body}\n`,
    frontMatter: {
      title: options.title ?? options.slug,
      type: options.type ?? "fact",
      status: "active",
      speaker: options.speaker ?? [],
      agents: options.agents ?? [],
      created: options.created ?? "2026-11-01T00:00:00.000Z",
      ...(options.edited === undefined ? {} : { edited: options.edited }),
      last_used: "2026-11-01T00:00:00.000Z",
      use_count: 0,
      decay_weight: 1,
      tags: [],
      links: [],
      emotional_flavour: "neutral",
    },
  };
}

function listHarness(nodes: unknown[]) {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  const recordUseCalls: unknown[] = [];
  const stubService = {
    async listCanonicalNodes() {
      return nodes;
    },
    async recordUse(slugs: unknown) {
      recordUseCalls.push(slugs);
    },
  };
  registerMemoryTools(pi, () => stubService as unknown as MemoryNodeService);
  const definition = definitions.get("memory_list") as {
    parameters: {
      properties: Record<string, { description?: string; enum?: readonly string[] }>;
    };
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    }>;
  };
  return { definition, recordUseCalls, definitions };
}

test("memory_list lists every type and its default in the parameter description", () => {
  const { definition, definitions } = listHarness([]);
  assert.ok(definitions.has("memory_list"));
  const type = definition.parameters.properties["type"];
  assert.deepEqual(type?.enum, MEMORY_TYPES);
  assert.match(type?.description ?? "", /fact, preference, event, person-note, or dream/u);
  assert.match(type?.description ?? "", /Default: every type except quarantined ones/u);
});

test("memory_list excludes dreams by default and orders newest first", async () => {
  const { definition, recordUseCalls } = listHarness([
    listNode({ slug: "older-fact", body: "Older.", created: "2026-11-01T12:00:00.000Z" }),
    listNode({ slug: "newer-event", type: "event", body: "Newer.", created: "2026-11-03T12:00:00.000Z", edited: "2026-11-09T12:00:00.000Z" }),
    listNode({ slug: "a-dream", type: "dream", body: "A dream.", created: "2026-11-10T12:00:00.000Z" }),
  ]);

  const result = await definition.execute("call", {});
  const text = result.content[0]?.text ?? "";
  assert.match(text, /2 memories \(dreams excluded\), newest first\./u);
  assert.doesNotMatch(text, /a-dream/u);
  assert.ok(text.indexOf("newer-event") < text.indexOf("older-fact"));
  assert.match(text, /modified: 2026-11-09T12:00:00\.000Z/u);
  assert.equal(result.details["total"], 2);
  // Listing is not retrieval: nothing is recorded as a use.
  assert.equal(recordUseCalls.length, 0);
});

test("memory_list type dream lists dreams and shows the model, not the stub speaker", async () => {
  const { definition } = listHarness([
    listNode({ slug: "a-fact", body: "A fact." }),
    listNode({
      slug: "a-dream",
      type: "dream",
      body: "A dream narrative.",
      created: "2026-11-10T12:00:00.000Z",
      speaker: [{ name: "pi-friend", confident: false, note: "synthesized dream" }],
      agents: ["openrouter/deepseek-v4"],
    }),
  ]);

  const result = await definition.execute("call", { type: "dream" });
  const text = result.content[0]?.text ?? "";
  assert.match(text, /1 memory \(type: dream\), newest first\./u);
  assert.match(text, /agents: openrouter\/deepseek-v4/u);
  assert.doesNotMatch(text, /Heard from: pi-friend/u);
  assert.doesNotMatch(text, /a-fact/u);
  assert.equal(result.details["count"], 1);
});

test("memory_list clamps bodies and says how many were cut, and 0 prints whole bodies", async () => {
  const body = "abcdefghij";
  const { definition } = listHarness([
    listNode({ slug: "long-one", body, created: "2026-11-01T12:00:00.000Z" }),
  ]);

  const clamped = await definition.execute("call", { body_chars: 5 });
  const clampedText = clamped.content[0]?.text ?? "";
  assert.match(clampedText, /abcde…/u);
  assert.match(
    clampedText,
    /The printed body was cut at 5 characters; pass body_chars: 0 for the whole body\./u,
  );
  assert.match(clampedText, /### long-one/u);
  assert.match(clampedText, /slug: long-one/u);
  assert.equal(clamped.details["clamped"], 1);

  const whole = await definition.execute("call", { body_chars: 0 });
  const wholeText = whole.content[0]?.text ?? "";
  assert.match(wholeText, /abcdefghij/u);
  assert.doesNotMatch(wholeText, /…/u);
  assert.doesNotMatch(wholeText, /cut at/u);
});

test("memory_list reports a limit and a date window in the header", async () => {
  const { definition } = listHarness([
    listNode({ slug: "before-window", body: "Before.", created: "2026-11-03T12:00:00.000Z" }),
    listNode({ slug: "inside-a", body: "Inside A.", created: "2026-11-07T12:00:00.000Z" }),
    listNode({ slug: "inside-b", body: "Inside B.", created: "2026-11-08T12:00:00.000Z" }),
  ]);

  const since = await definition.execute("call", { since: "2026-11-05" });
  const sinceText = since.content[0]?.text ?? "";
  assert.match(sinceText, /2 memories \(dreams excluded; since 2026-11-05\), newest first\./u);
  assert.doesNotMatch(sinceText, /before-window/u);

  const until = await definition.execute("call", { until: "2026-11-05" });
  assert.match(until.content[0]?.text ?? "", /1 memory \(dreams excluded; until 2026-11-05\), newest first\./u);

  const limited = await definition.execute("call", { limit: 1 });
  const limitedText = limited.content[0]?.text ?? "";
  assert.match(limitedText, /Showing 1 of 3\./u);
  assert.equal(limited.details["count"], 1);
  assert.equal(limited.details["total"], 3);
});

test("memory_list says when nothing matches", async () => {
  const { definition } = listHarness([
    listNode({ slug: "a-fact", body: "A fact." }),
  ]);
  const result = await definition.execute("call", { type: "person-note" });
  assert.equal(result.content[0]?.text, "No memories match (type: person-note).");
});

test("memory_list leads with the title and keeps the slug on its own line", async () => {
  const { definition } = listHarness([
    listNode({ slug: "a-readable-slug", title: "A readable title", body: "Body." }),
  ]);
  const text = (await definition.execute("call", {})).content[0]?.text ?? "";
  assert.match(text, /### A readable title\nslug: a-readable-slug\n/u);
});

test("memory_list counts cut bodies in the plural", async () => {
  const { definition } = listHarness([
    listNode({ slug: "long-a", body: "abcdefghij" }),
    listNode({ slug: "long-b", body: "klmnopqrst" }),
  ]);
  const text = (await definition.execute("call", { body_chars: 4 })).content[0]?.text ?? "";
  assert.match(
    text,
    /2 of the 2 printed bodies were cut at 4 characters; pass body_chars: 0 for whole bodies\./u,
  );
});
