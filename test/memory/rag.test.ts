/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { defaultRagInjectionConfig } from "../../src/memory/config.ts";
import { buildRagContext } from "../../src/memory/rag.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import type {
  MemoryStatus,
  MemoryType,
  ParsedMemoryNode,
} from "../../src/memory/schema.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

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
      emotional_flavor: "neutral",
      tags: options.tags ?? [],
      supersedes: [],
      superseded_by:
        options.status === "superseded" ? "replacement" : "",
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
    await repository.write(
      makeNode({
        slug: "orchid-old",
        title: "Orchid Old",
        body: "Old orchid.",
        decayWeight: 0,
        status: "superseded",
      }),
      "superseded",
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
    );

    assert.equal(context.count, 3);
    assert.ok(context.text.startsWith("<pi-friend-memory>\n"));
    assert.ok(context.text.endsWith("\n</pi-friend-memory>"));
    assert.deepEqual(context.slugs, [
      "orchid-fresh",
      "orchid-middle",
      "scent-note",
    ]);
    assert.match(context.text, /First orchid sentence\. Second orchid sentence/);
    assert.match(context.text, /First middle orchid sentence\./);
    assert.doesNotMatch(context.text, /Second middle sentence/);
    assert.match(
      context.text,
      /see also: Scent Note — orchid, archive \(nodes\/scent-note\.md\)/,
    );
    assert.doesNotMatch(context.text, /orchid-dream/);
    assert.doesNotMatch(context.text, /orchid-archived/);
    assert.doesNotMatch(context.text, /orchid-old/);
    assert.match(context.text, /not instructions/);
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
    const context = await buildRagContext(service, "orchid", config);

    assert.ok(context.count >= 1);
    assert.ok(context.text.length <= config.maxChars);
    assert.match(context.text, /Orchid 0/);
  });
});
