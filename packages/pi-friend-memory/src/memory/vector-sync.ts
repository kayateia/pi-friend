/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./embedding.ts";
import type { IndexedMarkdownFile } from "./indexer.ts";
import type {
  VectorIndex,
  VectorRecord,
} from "./vector-index.ts";

/** Summary of one index synchronization pass. */
export interface VectorSyncResult {
  total: number;
  embedded: number;
  skipped: number;
  removed: number;
}

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
  } = {},
): Promise<VectorSyncResult> {
  const existing = new Map(
    index.listEntries().map((entry) => [entry.key, entry]),
  );
  const desired = files
    .filter(
      (file) => file.body.trim() !== "" || file.title !== undefined,
    )
    .map((file) => {
      const embeddingText = buildEmbeddingText(file);
      return {
        file,
        key: vectorKey(file),
        embeddingText,
        contentHash: hashVectorInput(file, embeddingText),
      };
    });
  const desiredKeys = new Set(desired.map((item) => item.key));
  const staleKeys =
    options.pruneMissing === false
      ? []
      : [...existing.keys()].filter((key) => !desiredKeys.has(key));
  const changed =
    options.force === true
      ? desired
      : desired.filter(
          (item) =>
            existing.get(item.key)?.contentHash !==
            item.contentHash,
        );

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
  changed.forEach((item, indexPosition) => {
    const embedding = embeddings[indexPosition];
    if (!embedding) {
      throw new Error(`Missing embedding for ${item.file.relativePath}.`);
    }
    index.upsert(toVectorRecord(item.key, item.file, item.contentHash, embedding));
  });

  return {
    total: desired.length,
    embedded: changed.length,
    skipped: desired.length - changed.length,
    removed: staleKeys.length,
  };
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

/** Hashes embedding input so unchanged Markdown avoids repeat API calls. */
export function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hashes embedding input plus metadata that affects stored index entries. */
export function hashVectorInput(
  file: IndexedMarkdownFile,
  embeddingText: string,
): string {
  const metadata = JSON.stringify({
    title: file.title ?? null,
    tags: file.tags,
    type: file.type ?? null,
    status: file.status ?? null,
    decayWeight: file.decayWeight ?? null,
  });
  return hashEmbeddingText(`${embeddingText}\n--metadata--\n${metadata}`);
}

/** Converts one indexed file plus its current embedding into a vector record. */
function toVectorRecord(
  key: string,
  file: IndexedMarkdownFile,
  contentHash: string,
  embedding: Float32Array,
): VectorRecord {
  return {
    key,
    kind: file.kind,
    sourcePath: file.relativePath,
    contentHash,
    embedding,
    ...(file.title === undefined ? {} : { title: file.title }),
    ...(file.type === undefined ? {} : { type: file.type }),
    ...(file.status === undefined ? {} : { status: file.status }),
    ...(file.decayWeight === undefined
      ? {}
      : { decayWeight: file.decayWeight }),
    tags: file.tags,
  };
}

/** Returns the stable vector key or the ordinary memory-relative path. */
function vectorKey(file: IndexedMarkdownFile): string {
  return file.vectorKey ?? file.relativePath;
}
