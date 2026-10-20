/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/memory/embedding.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/** Embedding provider that treats kitchen-related memories as near duplicates. */
class PromotionTestProvider implements EmbeddingProvider {
  readonly model = "test/promotion";
  readonly dimensions = 3;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      return normalized.includes("kitchen") ||
        normalized.includes("cozy") ||
        normalized.includes("warm")
        ? new Float32Array([1, 0, 0])
        : new Float32Array([0, 1, 0]);
    });
  }
}

test("staging is idempotent and promotion creates an active canonical node", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T00:00:00.000Z"),
    );
    const input = {
      title: "Blue Cup",
      type: "fact" as const,
      body: "The blue cup belongs on the second shelf.",
      speaker: [{ name: "Aisling", confident: true }],
      tags: ["kitchen"],
    };

    const first = await service.stageCandidate(input);
    const duplicate = await service.stageCandidate(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(await service.read(first.node.slug), null);
    assert.equal(
      (await service.read(first.node.slug, "staging"))?.frontMatter.status,
      "candidate",
    );

    const promoted = await service.promoteCandidate(first.node.slug);
    assert.equal(promoted.merged, false);
    assert.equal(promoted.node.frontMatter.status, "active");
    assert.match(promoted.node.body, /promoted from staging/);
    assert.equal(await service.read(first.node.slug, "staging"), null);
    assert.equal(
      (await service.read(first.node.slug))?.frontMatter.status,
      "active",
    );
  });
});

test("promotion merges semantic near-duplicates and preserves links", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const index = SqliteVectorIndex.open({
      databasePath: ":memory:",
      model: "test/promotion",
      dimensions: 3,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T00:00:00.000Z"),
      {
        provider: new PromotionTestProvider(),
        index,
      },
    );
    try {
      const canonical = await service.add({
        title: "Warm Kitchen",
        type: "fact",
        body: "The kitchen has warm light.",
        speaker: [{ name: "Aisling", confident: true }],
        tags: ["home"],
        links: ["existing-link"],
      });
      const staged = await service.stageCandidate({
        title: "Cozy Kitchen",
        type: "preference",
        body: "The cozy kitchen is a favourite place.",
        speaker: [
          { name: "Aisling", confident: true },
          { name: "Lime Pi", confident: false },
        ],
        tags: ["comfort"],
        links: ["candidate-link"],
      });

      const promoted = await service.promoteCandidate(staged.node.slug);
      assert.equal(promoted.merged, true);
      assert.equal(promoted.mergedInto, canonical.slug);
      assert.equal(promoted.node.slug, canonical.slug);
      assert.match(promoted.node.body, /The kitchen has warm light\./);
      assert.match(promoted.node.body, /The cozy kitchen is a favourite place\./);
      assert.match(promoted.node.body, /merged staging candidate cozy-kitchen/);
      assert.deepEqual(promoted.node.frontMatter.tags, [
        "home",
        "comfort",
      ]);
      assert.deepEqual(promoted.node.frontMatter.links, [
        "existing-link",
        "candidate-link",
      ]);
      assert.equal(promoted.node.frontMatter.speaker.length, 2);
      assert.equal(await service.read(staged.node.slug, "staging"), null);
    } finally {
      index.close();
    }
  });
});
