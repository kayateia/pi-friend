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
import { fuseHybridResults } from "../../src/memory/hybrid-search.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import {
  formatRetrievalExplanation,
  type MemorySearchResult,
} from "../../src/memory/search.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/** Creates one minimal result fixture. */
function result(
  relativePath: string,
  matchedFields: MemorySearchResult["matchedFields"],
): MemorySearchResult {
  return {
    relativePath,
    kind: "document",
    snippet: relativePath,
    score: 0,
    matchedFields,
  };
}

test("reciprocal-rank fusion promotes results present in both lists", () => {
  const keyword = [
    result("docs/a.md", ["title"]),
    result("docs/shared.md", ["body"]),
  ];
  const semantic = [
    result("docs/c.md", ["semantic"]),
    result("docs/shared.md", ["semantic"]),
  ];

  const fused = fuseHybridResults(keyword, semantic, 5);
  assert.equal(fused[0]?.relativePath, "docs/shared.md");
  assert.deepEqual(fused[0]?.matchedFields, ["body", "semantic"]);
  assert.equal(fused[0]?.keywordRank, 2);
  assert.equal(fused[0]?.semanticRank, 2);
  assert.equal(fused.length, 3);
  assert.equal(
    formatRetrievalExplanation(fused[0]!),
    "Why recalled: semantic rank #2 · keyword rank #2 · matched fields: body · score 0.0323",
  );
});

/** Provider maps warm and cozy content into the same semantic direction. */
class HybridTestProvider implements EmbeddingProvider {
  readonly model = "test/hybrid";
  readonly dimensions = 3;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (
        normalized.includes("warm") ||
        normalized.includes("cozy") ||
        normalized.includes("affectionate")
      ) {
        return new Float32Array([1, 0, 0]);
      }
      return new Float32Array([0, 1, 0]);
    });
  }
}

test("hybrid search fuses keyword and semantic candidates", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const index = SqliteVectorIndex.open({
      databasePath: ":memory:",
      model: "test/hybrid",
      dimensions: 3,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T00:00:00.000Z"),
      {
        provider: new HybridTestProvider(),
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
        title: "Cozy Memory",
        type: "fact",
        body: "A cozy affectionate recollection.",
        speaker: [{ name: "Aisling", confident: true }],
      });

      const results = await service.search({
        query: "warm",
        mode: "hybrid",
      });
      assert.equal(results[0]?.slug, "warm-memory");
      assert.equal(results[0]?.keywordRank, 1);
      assert.ok(results[0]?.semanticRank !== undefined);
      assert.ok(results[0]?.matchedFields.includes("semantic"));
      assert.ok(
        results.some((entry) => entry.slug === "cozy-memory"),
      );

      const accessLog = await repository.store.readTextFile("access-log");
      assert.match(accessLog, /"tier":"hybrid"/);
    } finally {
      index.close();
    }
  });
});

test("hybrid mode fails clearly without embedding configuration", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    await assert.rejects(
      () => service.search({ query: "test", mode: "hybrid" }),
      /Semantic and hybrid search are unavailable/,
    );
  });
});
