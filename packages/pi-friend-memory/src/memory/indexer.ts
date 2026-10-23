/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import {
  parseYamlRecord,
  splitMarkdownFrontMatter,
} from "./frontmatter.ts";
import type { MemoryFileKind } from "./paths.ts";
import { validateSlug } from "./paths.ts";
import type {
  MemoryStatus,
  MemoryType,
} from "./schema.ts";
import {
  MemorySchemaError,
  parseMemoryNodeFile,
} from "./schema.ts";
import type { MemoryStore } from "./store.ts";

/** One Markdown file prepared for keyword search. */
export interface IndexedMarkdownFile {
  absolutePath: string;
  relativePath: string;
  /** Stable vector-index key when it differs from the display path. */
  vectorKey?: string;
  /** Classification implied by storage location. */
  storageKind: MemoryFileKind;
  /** Effective search kind after schema fallback. */
  kind: MemoryFileKind;
  slug?: string;
  title?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  decayWeight?: number;
  tags: string[];
  body: string;
  /** File modification timestamp, when indexing imported Markdown. */
  modifiedAt?: string;
  /** Fallible origin label for imported content. */
  provenance?: string;
  schemaError?: string;
}

/**
 * Builds a typed search index without modifying any Markdown files.
 *
 * Valid files under nodes/ and staging/ use the strict memory schema.
 * Malformed or absent schema data falls back to ordinary-document indexing so
 * one damaged file cannot make the entire memory tree unsearchable.
 */
export async function buildMemoryDocumentIndex(
  store: MemoryStore,
): Promise<IndexedMarkdownFile[]> {
  const files = await store.listMarkdownFiles();
  return Promise.all(
    files.map(async (file): Promise<IndexedMarkdownFile> => {
      const text = await store.readTextFile(file.relativePath);

      if (file.kind !== "document") {
        try {
          const node = parseMemoryNodeFile(text, {
            kind: file.kind,
            relativePath: file.relativePath,
          });
          return {
            absolutePath: file.absolutePath,
            relativePath: file.relativePath,
            storageKind: file.kind,
            kind: file.kind,
            slug: node.slug,
            title: node.frontMatter.title,
            type: node.frontMatter.type,
            status: node.frontMatter.status,
            decayWeight: node.frontMatter.decay_weight,
            tags: [...node.frontMatter.tags],
            body: node.body,
          };
        } catch (error) {
          if (!(error instanceof MemorySchemaError)) {
            throw error;
          }

          return buildDocumentIndexEntry(
            text,
            file.absolutePath,
            file.relativePath,
            file.kind,
            error.message,
          );
        }
      }

      return buildDocumentIndexEntry(
        text,
        file.absolutePath,
        file.relativePath,
        file.kind,
      );
    }),
  );
}

/** Builds a permissive document entry from arbitrary Markdown. */
export function buildDocumentIndexEntry(
  text: string,
  absolutePath: string,
  relativePath: string,
  storageKind: MemoryFileKind,
  schemaError?: string,
): IndexedMarkdownFile {
  const sections = splitMarkdownFrontMatter(text);
  let metadata: Record<string, unknown> | null = null;
  let body = text;

  if (sections) {
    const parsed = parseYamlRecord(sections.frontMatter);
    if (parsed.ok) {
      metadata = parsed.value;
      body = sections.body;
    }
  }

  const rawSlug = path.posix.basename(relativePath, ".md");
  const title =
    typeof metadata?.title === "string" && metadata.title.trim() !== ""
      ? metadata.title.trim()
      : extractMarkdownTitle(body);
  const tags =
    Array.isArray(metadata?.tags)
      ? metadata.tags.filter(
          (tag): tag is string => typeof tag === "string" && tag.trim() !== "",
        )
      : [];

  return {
    absolutePath,
    relativePath,
    storageKind,
    kind: "document",
    ...(isSlug(rawSlug) ? { slug: rawSlug } : {}),
    ...(title === undefined ? {} : { title }),
    tags,
    body,
    ...(schemaError === undefined ? {} : { schemaError }),
  };
}

/** Uses the first Markdown heading as a document title fallback. */
function extractMarkdownTitle(body: string): string | undefined {
  const match = /^#{1,6}[ \t]+(.+?)[ \t]*$/mu.exec(body);
  return match?.[1]?.trim() || undefined;
}

/** Returns true when a name already satisfies the memory slug contract. */
function isSlug(value: string): boolean {
  try {
    validateSlug(value);
    return true;
  } catch {
    return false;
  }
}
