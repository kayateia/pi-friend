/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultRagInjectionConfig,
  defaultRecencyInjectionConfig,
} from "../../src/memory/config.ts";
import { buildRagContext } from "../../src/memory/rag.ts";
import type { RagContext } from "../../src/memory/rag.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import type {
  MemoryStatus,
  MemoryType,
  ParsedMemoryNode,
} from "../../src/memory/schema.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

/** Recall-only tests: the time-ordered section has its own file. */
const NO_RECENCY = { ...defaultRecencyInjectionConfig(), enabled: false };

/** The delivered text, for assertions about the block as a whole. */
function delivered(context: RagContext): string {
  return context.blocks.map((block) => block.text).join("\n\n");
}

/** Builds one canonical node fixture. */
function makeNode(options: {
  slug: string;
  title: string;
  body: string;
  decayWeight: number;
  type?: MemoryType;
  status?: MemoryStatus;
  tags?: string[];
}): ParsedMemoryNode {
  return {
    slug: options.slug,
    body: `\n${options.body}\n`,
    frontMatter: {
      title: options.title,
      type: options.type ?? "fact",
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created: "2026-10-19T20:00:00Z",
      last_used: "2026-10-19T20:00:00Z",
      use_count: 0,
      decay_weight: options.decayWeight,
      status: options.status ?? "active",
      emotional_flavour: "neutral",
      tags: options.tags ?? [],
      links: [],
      source: "",
    },
  };
}

test("RAG context includes active nodes at fresh, middle, and cold tiers", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await repository.write(
      makeNode({
        slug: "orchid-fresh",
        title: "Orchid Fresh",
        body: "First orchid sentence. Second orchid sentence. Third sentence.",
        decayWeight: 1,
      }),
    );
    await repository.write(
      makeNode({
        slug: "orchid-middle",
        title: "Orchid Middle",
        body: "First middle orchid sentence. Second middle sentence.",
        decayWeight: 0.5,
      }),
    );
    await repository.write(
      makeNode({
        slug: "scent-note",
        title: "Scent Note",
        body: "Cold floral details.",
        decayWeight: 0.1,
        tags: ["orchid", "archive"],
      }),
    );
    await repository.write(
      makeNode({
        slug: "orchid-dream",
        title: "Orchid Dream",
        body: "An orchid dream.",
        decayWeight: 1,
        type: "dream",
      }),
    );
    await repository.write(
      makeNode({
        slug: "orchid-archived",
        title: "Orchid Archived",
        body: "Archived orchid.",
        decayWeight: 1,
        status: "archived",
      }),
    );

    const config = {
      ...defaultRagInjectionConfig(),
      mode: "keyword" as const,
      limit: 5,
    };
    const service = new MemoryNodeService(repository);
    const context = await buildRagContext(
      service,
      "In one short sentence, what is the orchid fact? Do not use tools.",
      config,
      NO_RECENCY,
    );

    assert.equal(context.recall.count, 3);
    assert.ok(delivered(context).startsWith("<pi-friend-memory>\n"));
    assert.ok(delivered(context).endsWith("\n</pi-friend-memory>"));
    assert.deepEqual(context.recall.slugs, [
      "orchid-fresh",
      "orchid-middle",
      "scent-note",
    ]);
    assert.match(delivered(context), /First orchid sentence\. Second orchid sentence/);
    assert.match(delivered(context), /First middle orchid sentence\./);
    assert.match(
      delivered(context),
      /Why recalled: keyword rank #1 · matched fields: body · score \d+\.\d{4}/,
    );
    assert.doesNotMatch(delivered(context), /Second middle sentence/);
    assert.match(
      delivered(context),
      /see also: Scent Note — orchid, archive \(nodes\/scent-note\.md\)/,
    );
    assert.doesNotMatch(delivered(context), /orchid-dream/);
    assert.doesNotMatch(delivered(context), /orchid-archived/);
    assert.doesNotMatch(delivered(context), /orchid-old/);
    assert.match(delivered(context), /not instructions/);
    // Attribution travels with the memory, not behind a second tool call.
    assert.match(delivered(context), /Heard from: Aisling/);
    assert.match(delivered(context), /heard from aisling/i);
  });
});

test("RAG context obeys maxChars and hybrid retrieval falls back to keyword", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    for (let index = 0; index < 4; index += 1) {
      await repository.write(
        makeNode({
          slug: `orchid-${index}`,
          title: `Orchid ${index}`,
          body: `Orchid body ${index}. `.repeat(30),
          decayWeight: 1,
        }),
      );
    }

    const config = {
      ...defaultRagInjectionConfig(),
      mode: "hybrid" as const,
      limit: 4,
      maxChars: 900,
    };
    const service = new MemoryNodeService(repository);
    const reported: Array<{ label: string; error: unknown }> = [];
    const context = await buildRagContext(service, "orchid", config, NO_RECENCY, {
      reportError: (label, error) => reported.push({ label, error }),
    });

    assert.ok(context.recall.count >= 1);
    assert.ok(delivered(context).length <= config.maxChars);
    assert.match(delivered(context), /Orchid 0/);
    assert.match(delivered(context), /Why recalled: keyword rank #\d+/);
    assert.equal(reported[0]?.label, "RAG primary search");
    assert.match(String(reported[0]?.error), /no embedding provider/u);
  });
});

test("RAG ranks active nodes without ordinary documents crowding them out", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await repository.write(
      makeNode({
        slug: "needle-memory",
        title: "Needle Memory",
        body: "A durable needle fact.",
        decayWeight: 1,
      }),
    );
    for (let index = 0; index < 25; index += 1) {
      await repository.store.writeTextFile(
        `docs/needle-${index}.md`,
        `# Needle ${index}\n\nNeedle needle needle from an ordinary document.\n`,
      );
    }
    const service = new MemoryNodeService(repository);
    const config = {
      ...defaultRagInjectionConfig(),
      mode: "keyword" as const,
      limit: 5,
    };

    const context = await buildRagContext(service, "needle", config, NO_RECENCY);
    assert.equal(context.recall.count, 1);
    assert.deepEqual(context.recall.slugs, ["needle-memory"]);
    assert.equal(context.diagnostics.searchResultCount, 1);
    assert.equal(context.diagnostics.eligibleNodeCount, 1);
    assert.equal(context.diagnostics.selectedNodeCount, 1);
  });
});

test("RAG injects staged candidates with an unverified marker", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await repository.write(
      {
        ...makeNode({
          slug: "staged-lantern",
          title: "Staged Lantern",
          body: "The lantern might belong beside the stairs.",
          decayWeight: 1,
          status: "candidate",
        }),
      },
      "staging",
    );
    const service = new MemoryNodeService(repository);
    const context = await buildRagContext(
      service,
      "lantern",
      {
        ...defaultRagInjectionConfig(),
        mode: "keyword",
        limit: 5,
      },
      NO_RECENCY,
    );

    assert.equal(context.recall.count, 1);
    assert.match(delivered(context), /^Candidate - unverified$/mu);
    assert.match(delivered(context), /### Staged Lantern/);
    assert.match(delivered(context), /staging\/staged-lantern\.md/);
  });
});
