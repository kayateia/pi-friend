/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/** One chunk of a larger source text. */
export interface TextChunk {
  /** Ordinal position of this chunk within its source. */
  index: number;
  /** Trimmed chunk text; never empty for non-empty sources. */
  content: string;
}

/** Defaults sized so one chunk stays far inside typical embedding limits. */
export const DEFAULT_CHUNK_SIZE = 4_000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const MIN_CONFIG_CHUNK_SIZE = 200;
export const MAX_CONFIG_CHUNK_SIZE = 20_000;

/**
 * Scales overlap down for small configured chunk sizes while keeping it below
 * the chunk boundary.
 */
export function resolveChunkOverlap(chunkSize: number): number {
  return Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 5));
}

/**
 * Splits text into overlapping chunks of at most `chunkSize` characters.
 *
 * Chunks prefer paragraph boundaries when one falls in the back half of the
 * window, so headings and blocks stay intact where the source allows it.
 * Short inputs produce a single chunk holding the trimmed text unchanged.
 */
export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = resolveChunkOverlap(chunkSize),
): TextChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("chunkSize must be a positive integer.");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error("overlap must satisfy 0 <= overlap < chunkSize.");
  }

  const source = text.trim();
  if (source === "") {
    return [{ index: 0, content: "" }];
  }
  if (source.length <= chunkSize) {
    return [{ index: 0, content: source }];
  }

  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;
  while (offset < source.length) {
    const end = Math.min(offset + chunkSize, source.length);
    let boundary = end;
    if (end < source.length) {
      const paragraphBreak = source.lastIndexOf("\n\n", end - 1);
      if (paragraphBreak > offset + chunkSize / 2) {
        boundary = paragraphBreak;
      }
    }

    const content = source.slice(offset, boundary).trim();
    if (content !== "") {
      chunks.push({ index, content });
      index += 1;
    }
    if (boundary >= source.length) {
      break;
    }
    offset = Math.max(boundary - overlap, offset + 1);
  }

  return chunks;
}
