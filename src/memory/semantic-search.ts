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
import type { VectorIndex } from "./vector-index.ts";
import { synchronizeVectorIndex } from "./vector-sync.ts";

/**
 * Refreshes the vector index and performs one semantic query.
 *
 * Keyword search remains independent; this function is called only when the
 * caller explicitly requests semantic mode.
 */
export async function searchSemantically(
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

  const limit = clampLimit(options.limit);
  const hits = index.search(queryEmbedding, Math.min(100, limit * 4));
  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  const results: MemorySearchResult[] = [];

  for (const hit of hits) {
    const file = fileByPath.get(hit.sourcePath);
    if (!file) {
      continue;
    }
    if (options.type !== undefined && file.type !== options.type) {
      continue;
    }

    results.push({
      relativePath: file.relativePath,
      kind: file.kind,
      ...(file.slug === undefined ? {} : { slug: file.slug }),
      ...(file.title === undefined ? {} : { title: file.title }),
      ...(file.type === undefined ? {} : { type: file.type }),
      ...(file.status === undefined ? {} : { status: file.status }),
      ...(file.decayWeight === undefined
        ? {}
        : { decayWeight: file.decayWeight }),
      snippet: makeSemanticSnippet(file),
      score: Math.max(0, 1 - hit.distance),
      matchedFields: ["semantic"],
      ...(file.schemaError === undefined
        ? {}
        : { schemaError: file.schemaError }),
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

/** Produces a short document preview for semantic results without a phrase. */
function makeSemanticSnippet(file: IndexedMarkdownFile): string {
  const source = (file.body.trim() || file.title || file.relativePath)
    .replace(/\s+/gu, " ")
    .trim();
  return source.length <= 220 ? source : `${source.slice(0, 219).trimEnd()}…`;
}

/** Clamps a requested result limit into the supported range. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 5;
  }
  return Math.min(25, Math.max(1, Math.floor(limit)));
}
