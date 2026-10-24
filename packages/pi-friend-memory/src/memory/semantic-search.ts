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
import {
  chunkText,
  DEFAULT_CHUNK_SIZE,
  resolveChunkOverlap,
} from "./chunker.ts";
import type { VectorIndex } from "./vector-index.ts";
import {
  synchronizeVectorIndex,
  vectorChunkIndex,
  vectorKey,
} from "./vector-sync.ts";

/** Optional controls shared by semantic synchronization and search. */
export interface VectorSearchOptions {
  signal?: AbortSignal;
  chunkSize?: number;
}

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
  vectorOptions: VectorSearchOptions = {},
): Promise<MemorySearchResult[]> {
  await synchronizeVectorIndex(files, provider, index, vectorOptions);
  const [queryEmbedding] = await provider.embed([options.query], {
    signal: vectorOptions.signal,
  });
  if (!queryEmbedding) {
    throw new Error("Embedding provider returned no query vector.");
  }

  return searchSemanticVectors(
    files,
    queryEmbedding,
    options,
    index,
    vectorOptions.chunkSize,
  );
}

/** Searches an already-synchronized index with a prepared query embedding. */
export function searchSemanticVectors(
  files: IndexedMarkdownFile[],
  queryEmbedding: Float32Array,
  options: MemorySearchOptions,
  index: VectorIndex,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): MemorySearchResult[] {
  const limit = clampLimit(options.limit);
  const hits = index.search(queryEmbedding, Math.min(100, limit * 4));
  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  const chunkCache = new Map<string, string[]>();
  const seenPaths = new Set<string>();
  const results: MemorySearchResult[] = [];

  for (const hit of hits) {
    const file = fileByPath.get(hit.sourcePath);
    if (!file || seenPaths.has(file.relativePath)) {
      continue;
    }
    seenPaths.add(file.relativePath);
    if (options.type !== undefined && file.type !== options.type) {
      continue;
    }
    if (options.kind !== undefined && file.kind !== options.kind) {
      continue;
    }
    if (options.status !== undefined && file.status !== options.status) {
      continue;
    }

    const rank = results.length + 1;
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
      ...(file.modifiedAt === undefined
        ? {}
        : { modifiedAt: file.modifiedAt }),
      ...(file.provenance === undefined
        ? {}
        : { provenance: file.provenance }),
      snippet: makeSemanticSnippet(
        file,
        hit.key,
        chunkSize,
        chunkCache,
      ),
      score: Math.max(0, 1 - hit.distance),
      matchedFields: ["semantic"],
      semanticRank: rank,
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

/** Produces a preview from the specific chunk that matched semantically. */
function makeSemanticSnippet(
  file: IndexedMarkdownFile,
  hitKey: string,
  chunkSize: number,
  chunkCache: Map<string, string[]>,
): string {
  const baseKey = vectorKey(file);
  const chunkIndex = vectorChunkIndex(hitKey, baseKey);
  let matchedText = file.body;
  if (chunkIndex !== undefined) {
    let chunks = chunkCache.get(file.relativePath);
    if (!chunks) {
      chunks = chunkText(
        file.body,
        chunkSize,
        resolveChunkOverlap(chunkSize),
      ).map((chunk) => chunk.content);
      chunkCache.set(file.relativePath, chunks);
    }
    matchedText = chunks[chunkIndex] ?? file.body;
  }

  const source = (matchedText.trim() || file.title || file.relativePath)
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
