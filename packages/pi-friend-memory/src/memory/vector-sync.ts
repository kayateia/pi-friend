/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import {
  chunkText,
  DEFAULT_CHUNK_SIZE,
  resolveChunkOverlap,
} from "./chunker.ts";
import type { EmbeddingProvider } from "./embedding.ts";
import type { IndexedMarkdownFile } from "./indexer.ts";
import type {
  VectorIndex,
  VectorEntryMetadata,
  VectorRecord,
  VectorRecordMetadata,
} from "./vector-index.ts";

/** Summary of one index synchronization pass. */
export interface VectorSyncResult {
  total: number;
  embedded: number;
  skipped: number;
  removed: number;
}

/** Decides whether one existing vector belongs to the synchronization scope. */
export type VectorPrunePredicate = (
  entry: VectorEntryMetadata,
) => boolean;

/** Serializes synchronization passes that share one process-local index. */
const synchronizationQueues = new WeakMap<VectorIndex, Promise<void>>();

/**
 * Synchronizes indexed Markdown into the vector store.
 *
 * Embedding calls complete before any index mutation, so a provider failure
 * leaves the previous derived index intact.
 */
export async function synchronizeVectorIndex(
  files: IndexedMarkdownFile[],
  provider: EmbeddingProvider,
  index: VectorIndex,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    /** Preserve entries outside this synchronization set when false. */
    pruneMissing?: boolean;
    /**
     * Limits stale-entry removal to matching records.
     *
     * The default applies to the entire index. External-source reconciliation
     * uses this to remove stale imports without touching memory-tree vectors.
     */
    prune?: VectorPrunePredicate;
    /** Maximum characters supplied to the embedding model per chunk. */
    chunkSize?: number;
  } = {},
): Promise<VectorSyncResult> {
  return withSynchronizationLock(index, () =>
    synchronizeVectorIndexUnlocked(files, provider, index, options),
  );
}

/** Runs one synchronization pass while the caller owns the index queue. */
async function synchronizeVectorIndexUnlocked(
  files: IndexedMarkdownFile[],
  provider: EmbeddingProvider,
  index: VectorIndex,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    /** Preserve entries outside this synchronization set when false. */
    pruneMissing?: boolean;
    /**
     * Limits stale-entry removal to matching records.
     *
     * The default applies to the entire index. External-source reconciliation
     * uses this to remove stale imports without touching memory-tree vectors.
     */
    prune?: VectorPrunePredicate;
    /** Maximum characters supplied to the embedding model per chunk. */
    chunkSize?: number;
  } = {},
): Promise<VectorSyncResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = resolveChunkOverlap(chunkSize);
  const existing = new Map(
    index.listEntries().map((entry) => [entry.key, entry]),
  );
  const desired = files
    .filter(
      (file) => file.body.trim() !== "" || file.title !== undefined,
    )
    .flatMap((file) => {
      const chunks = chunkText(
        file.body,
        chunkSize,
        chunkOverlap,
      );
      if (chunks.length <= 1) {
        const embeddingText = buildEmbeddingText(file);
        return [
          {
            file,
            key: vectorKey(file),
            embeddingText,
            contentHash: hashVectorInput(embeddingText),
          },
        ];
      }

      return chunks.map((chunk) => {
        const embeddingText = buildChunkEmbeddingText(file, chunk.content);
        return {
          file,
          key: vectorChunkKey(vectorKey(file), chunk.index),
          embeddingText,
          contentHash: hashChunkVectorInput(embeddingText),
        };
      });
    });
  const desiredKeys = new Set(desired.map((item) => item.key));
  const staleKeys =
    options.pruneMissing === false
      ? []
      : [...existing.entries()]
          .filter(
            ([key, entry]) =>
              !desiredKeys.has(key) && (options.prune?.(entry) ?? true),
          )
          .map(([key]) => key);
  const changed =
    options.force === true
      ? desired
      : desired.filter(
          (item) =>
            existing.get(item.key)?.contentHash !==
            item.contentHash,
        );
  // An entry whose text is unchanged but whose description is not — a decay
  // weight after a sweep, a status, a modification date — is rewritten in the
  // index without asking the provider for a vector it already holds.
  const metadataOnly = desired.filter((item) => {
    const entry = existing.get(item.key);
    return (
      entry !== undefined &&
      options.force !== true &&
      entry.contentHash === item.contentHash &&
      !metadataMatches(entry, toVectorMetadata(item.key, item.file, item.contentHash))
    );
  });

  options.signal?.throwIfAborted();
  const embeddings =
    changed.length === 0
      ? []
      : await provider.embed(
          changed.map((item) => item.embeddingText),
          { signal: options.signal },
        );
  if (embeddings.length !== changed.length) {
    throw new Error(
      `Embedding provider returned ${embeddings.length} vectors for ${changed.length} inputs.`,
    );
  }

  for (const key of staleKeys) {
    index.remove(key);
  }
  for (const item of metadataOnly) {
    index.updateMetadata(
      toVectorMetadata(item.key, item.file, item.contentHash),
    );
  }
  changed.forEach((item, indexPosition) => {
    const embedding = embeddings[indexPosition];
    if (!embedding) {
      throw new Error(`Missing embedding for ${item.file.relativePath}.`);
    }
    index.upsert(
      toVectorRecord(item.key, item.file, item.contentHash, embedding),
    );
  });

  return {
    total: desired.length,
    embedded: changed.length,
    skipped: desired.length - changed.length,
    removed: staleKeys.length,
  };
}

/**
 * Runs one index operation after earlier process-local passes have completed.
 *
 * Separate Pi conversations can share a root and index. This queue prevents a
 * watcher refresh from interleaving its read-embed-write sequence with search
 * or sweep synchronization in the same process.
 */
async function withSynchronizationLock<T>(
  index: VectorIndex,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = synchronizationQueues.get(index);
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  synchronizationQueues.set(index, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (synchronizationQueues.get(index) === current) {
      synchronizationQueues.delete(index);
    }
  }
}

/** Builds the exact searchable text supplied to the embedding model. */
export function buildEmbeddingText(file: IndexedMarkdownFile): string {
  return [
    file.title ?? "",
    file.tags.map((tag) => `#${tag}`).join(" "),
    file.relativePath,
    file.body.trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** Builds searchable text for one chunk of a larger indexed file. */
export function buildChunkEmbeddingText(
  file: IndexedMarkdownFile,
  chunkContent: string,
): string {
  return [
    file.title ?? "",
    file.tags.map((tag) => `#${tag}`).join(" "),
    file.relativePath,
    chunkContent.trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** Hashes embedding input so unchanged Markdown avoids repeat API calls. */
export function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hashes one chunk's embedding input.
 *
 * Only the text that is embedded contributes. Anything else — a decay weight,
 * a status, a date — can be rewritten in the index without paying the provider
 * for a vector identical to the one already stored, and `synchronizeVectorIndex`
 * updates those fields separately. Including them here is what made a sweep's
 * decay pass re-embed most of the store.
 */
export function hashChunkVectorInput(embeddingText: string): string {
  return hashEmbeddingText(embeddingText);
}

/** Hashes one file's embedding input; see `hashChunkVectorInput`. */
export function hashVectorInput(embeddingText: string): string {
  return hashEmbeddingText(embeddingText);
}

/** Converts one indexed file plus its current embedding into a vector record. */
function toVectorRecord(
  key: string,
  file: IndexedMarkdownFile,
  contentHash: string,
  embedding: Float32Array,
): VectorRecord {
  return {
    ...toVectorMetadata(key, file, contentHash),
    embedding,
  };
}

/** Describes one indexed file the way the index stores it, minus its vector. */
function toVectorMetadata(
  key: string,
  file: IndexedMarkdownFile,
  contentHash: string,
): VectorRecordMetadata {
  return {
    key,
    kind: file.kind,
    sourcePath: file.relativePath,
    contentHash,
    ...(file.title === undefined ? {} : { title: file.title }),
    ...(file.type === undefined ? {} : { type: file.type }),
    ...(file.status === undefined ? {} : { status: file.status }),
    ...(file.decayWeight === undefined
      ? {}
      : { decayWeight: file.decayWeight }),
    ...(file.modifiedAt === undefined ? {} : { modifiedAt: file.modifiedAt }),
    tags: file.tags,
  };
}

/** Returns whether a stored entry already describes one file exactly. */
function metadataMatches(
  entry: VectorEntryMetadata,
  metadata: VectorRecordMetadata,
): boolean {
  return (
    entry.kind === metadata.kind &&
    entry.sourcePath === metadata.sourcePath &&
    entry.contentHash === metadata.contentHash &&
    (entry.title ?? null) === (metadata.title ?? null) &&
    (entry.type ?? null) === (metadata.type ?? null) &&
    (entry.status ?? null) === (metadata.status ?? null) &&
    (entry.decayWeight ?? null) === (metadata.decayWeight ?? null) &&
    (entry.modifiedAt ?? null) === (metadata.modifiedAt ?? null) &&
    entry.tags.length === (metadata.tags ?? []).length &&
    entry.tags.every((tag, position) => tag === (metadata.tags ?? [])[position])
  );
}

/** Returns the stable vector key or the ordinary memory-relative path. */
export function vectorKey(file: IndexedMarkdownFile): string {
  return file.vectorKey ?? file.relativePath;
}

/** Builds the stable vector key for one chunk of a source file. */
export function vectorChunkKey(baseKey: string, chunkIndex: number): string {
  return `${baseKey}#chunk:${chunkIndex}`;
}

/** Parses a chunk ordinal from a vector key, or returns undefined. */
export function vectorChunkIndex(
  key: string,
  baseKey: string,
): number | undefined {
  const prefix = `${baseKey}#chunk:`;
  if (!key.startsWith(prefix)) {
    return undefined;
  }
  const value = Number(key.slice(prefix.length));
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
