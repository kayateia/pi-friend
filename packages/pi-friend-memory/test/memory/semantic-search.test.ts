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

/** Embedding provider that maps warm/cold words into orthogonal vectors. */
class SemanticTestProvider implements EmbeddingProvider {
  readonly model = "test/semantic";
  readonly dimensions = 3;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("warm")) {
        return new Float32Array([1, 0, 0]);
      }
      if (normalized.includes("cold")) {
        return new Float32Array([0, 1, 0]);
      }
      return new Float32Array([0.05, 0.05, 1]);
    });
  }
}

test("semantic search embeds documents and reports access-log tier", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const index = SqliteVectorIndex.open({
      databasePath: ":memory:",
      model: "test/semantic",
      dimensions: 3,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T00:00:00.000Z"),
      {
        provider: new SemanticTestProvider(),
        index,
      },
    );
    try {
      await service.add({
        title: "Warm Memory",
        type: "fact",
        body: "A warm recollection.",
        speaker: [{ name: "Aisling", confident: true }],
      });
      await service.add({
        title: "Cold Memory",
        type: "fact",
        body: "A cold recollection.",
        speaker: [{ name: "Aisling", confident: true }],
      });

      const results = await service.search({
        query: "warm",
        mode: "semantic",
      });
      assert.equal(results[0]?.slug, "warm-memory");
      assert.deepEqual(results[0]?.matchedFields, ["semantic"]);
      assert.equal(results[0]?.semanticRank, 1);
      assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));

      const accessLog = await repository.store.readTextFile("access-log");
      assert.match(accessLog, /"tier":"semantic"/);
    } finally {
      index.close();
    }
  });
});

test("semantic mode fails clearly when no provider is configured", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    await assert.rejects(
      () => service.search({ query: "test", mode: "semantic" }),
      /no embedding provider is configured/,
    );
  });
});
