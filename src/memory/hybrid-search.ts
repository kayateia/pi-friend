/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EmbeddingProvider } from "./embedding.ts";
import type { IndexedMarkdownFile } from "./indexer.ts";
import type {
  MemorySearchOptions,
  MemorySearchResult,
} from "./search.ts";
import { searchIndexedFiles } from "./search.ts";
import { searchSemanticVectors } from "./semantic-search.ts";
import type { VectorIndex } from "./vector-index.ts";
import { synchronizeVectorIndex } from "./vector-sync.ts";

const RRF_K = 60;
const CANDIDATE_LIMIT = 25;

/**
 * Combines keyword and semantic results with reciprocal-rank fusion.
 *
 * The vector index is synchronized first and both candidate lists are
 * deduplicated by canonical source path.
 */
export async function searchHybrid(
  files: IndexedMarkdownFile[],
  options: MemorySearchOptions,
  provider: EmbeddingProvider,
  index: VectorIndex,
  signal?: AbortSignal,
): Promise<MemorySearchResult[]> {
  await synchronizeVectorIndex(files, provider, index, { signal });
  const [queryEmbedding] = await provider.embed([options.query], { signal });
  if (!queryEmbedding) {
    throw new Error("Embedding provider returned no query vector.");
  }

  const candidateOptions: MemorySearchOptions = {
    ...options,
    limit: CANDIDATE_LIMIT,
  };
  const keywordResults = searchIndexedFiles(files, candidateOptions);
  const semanticResults = searchSemanticVectors(
    files,
    queryEmbedding,
    candidateOptions,
    index,
  );
  return fuseHybridResults(keywordResults, semanticResults, options.limit);
}

/**
 * Reciprocal-rank fusion helper exposed for deterministic ranking tests.
 */
export function fuseHybridResults(
  keywordResults: MemorySearchResult[],
  semanticResults: MemorySearchResult[],
  limit: number | undefined,
): MemorySearchResult[] {
  const merged = new Map<
    string,
    {
      result: MemorySearchResult;
      score: number;
      fields: Set<MemorySearchResult["matchedFields"][number]>;
      keywordRank?: number;
      semanticRank?: number;
    }
  >();

  keywordResults.forEach((result, index) => {
    addRankedResult(merged, result, index + 1, "keyword");
  });
  semanticResults.forEach((result, index) => {
    addRankedResult(merged, result, index + 1, "semantic");
  });

  return [...merged.values()]
    .map((entry) => ({
      ...entry.result,
      score: entry.score,
      matchedFields: [...entry.fields],
      ...(entry.keywordRank === undefined
        ? {}
        : { keywordRank: entry.keywordRank }),
      ...(entry.semanticRank === undefined
        ? {}
        : { semanticRank: entry.semanticRank }),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0;
    })
    .slice(0, clampLimit(limit));
}

/** Adds one result's reciprocal-rank contribution to the merged set. */
function addRankedResult(
  merged: Map<
    string,
    {
      result: MemorySearchResult;
      score: number;
      fields: Set<MemorySearchResult["matchedFields"][number]>;
      keywordRank?: number;
      semanticRank?: number;
    }
  >,
  incoming: MemorySearchResult,
  rank: number,
  source: "keyword" | "semantic",
): void {
  const existing = merged.get(incoming.relativePath);
  const contribution = 1 / (RRF_K + rank);
  if (existing) {
    existing.score += contribution;
    for (const field of incoming.matchedFields) {
      existing.fields.add(field);
    }
    if (source === "keyword") {
      existing.keywordRank = rank;
      existing.result.snippet = incoming.snippet;
    } else {
      existing.semanticRank = rank;
    }
    return;
  }

  merged.set(incoming.relativePath, {
    result: { ...incoming },
    score: contribution,
    fields: new Set(incoming.matchedFields),
    ...(source === "keyword" ? { keywordRank: rank } : { semanticRank: rank }),
  });
}

/** Clamps a requested result limit into the supported range. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 5;
  }
  return Math.min(25, Math.max(1, Math.floor(limit)));
}
