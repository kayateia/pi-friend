/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IndexedMarkdownFile } from "./indexer.ts";
import type {
  MemoryStatus,
  MemoryType,
} from "./schema.ts";

/** Supported search modes for the initial implementation. */
export type MemorySearchMode = "keyword" | "semantic" | "hybrid";

/** Input for a keyword search over indexed Markdown files. */
export interface MemorySearchOptions {
  query: string;
  mode?: MemorySearchMode;
  type?: MemoryType;
  limit?: number;
  /** Minimum meaningful token overlap when no phrase match occurs. */
  minTokenMatches?: number;
}

/** One ranked search result with a match-centered snippet. */
export interface MemorySearchResult {
  relativePath: string;
  kind: IndexedMarkdownFile["kind"];
  slug?: string;
  title?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  decayWeight?: number;
  modifiedAt?: string;
  provenance?: string;
  snippet: string;
  score: number;
  matchedFields: SearchField[];
  schemaError?: string;
  /** One-based keyword rank when the result also appeared in keyword search. */
  keywordRank?: number;
  /** One-based semantic rank when vector search returned the result. */
  semanticRank?: number;
}

/** Indexed fields that can contribute to a keyword result. */
export type SearchField =
  | "slug"
  | "path"
  | "title"
  | "tags"
  | "body"
  | "semantic";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

/** Searches one in-memory index using deterministic keyword ranking. */
export function searchIndexedFiles(
  files: IndexedMarkdownFile[],
  options: MemorySearchOptions,
): MemorySearchResult[] {
  const query = normalize(options.query);
  if (query === "") {
    throw new Error("Search query must not be empty.");
  }

  const queryTokens = tokenize(query);
  const limit = clampLimit(options.limit);
  const results: MemorySearchResult[] = [];

  for (const file of files) {
    if (options.type !== undefined && file.type !== options.type) {
      continue;
    }

    const score = scoreFile(
      file,
      query,
      queryTokens,
      options.minTokenMatches,
    );
    if (score === null) {
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
      ...(file.modifiedAt === undefined
        ? {}
        : { modifiedAt: file.modifiedAt }),
      ...(file.provenance === undefined
        ? {}
        : { provenance: file.provenance }),
      snippet: makeSnippet(file, query, queryTokens),
      score: score.value,
      matchedFields: score.fields,
      ...(file.schemaError === undefined
        ? {}
        : { schemaError: file.schemaError }),
    });
  }

  return results
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
    .slice(0, limit);
}

/** Scores one indexed file, or returns null when no query field matches. */
function scoreFile(
  file: IndexedMarkdownFile,
  query: string,
  tokens: string[],
  minTokenMatches: number | undefined,
): { value: number; fields: SearchField[] } | null {
  const slug = normalize(file.slug ?? "");
  const relativePath = normalize(file.relativePath);
  const title = normalize(file.title ?? "");
  const tags = file.tags.map(normalize);
  const body = normalize(file.body);
  const haystack = [slug, relativePath, title, tags.join(" "), body].join("\n");

  const fields: SearchField[] = [];
  let value = 0;
  let phraseMatch = false;

  if (slug === query) {
    value += 1_000;
    fields.push("slug");
    phraseMatch = true;
  } else if (slug.includes(query)) {
    value += 500;
    fields.push("slug");
    phraseMatch = true;
  }

  if (relativePath.includes(query)) {
    value += 350;
    if (!fields.includes("path")) fields.push("path");
    phraseMatch = true;
  }

  if (title === query) {
    value += 900;
    fields.push("title");
    phraseMatch = true;
  } else if (title.includes(query)) {
    value += 650;
    fields.push("title");
    phraseMatch = true;
  }

  if (tags.includes(query)) {
    value += 600;
    fields.push("tags");
    phraseMatch = true;
  } else if (tags.some((tag) => tag.includes(query))) {
    value += 400;
    fields.push("tags");
    phraseMatch = true;
  }

  if (body.includes(query)) {
    value += 200;
    fields.push("body");
    phraseMatch = true;
  }

  const matchedTokenCount = tokens.filter((token) =>
    haystack.includes(token),
  ).length;
  const allTokensPresent =
    tokens.length > 0 && matchedTokenCount === tokens.length;
  const requiredMatches =
    minTokenMatches === undefined
      ? tokens.length
      : Math.max(1, Math.floor(minTokenMatches));
  if (!phraseMatch && matchedTokenCount < requiredMatches) {
    return null;
  }
  if (allTokensPresent) {
    value += 50;
    const firstToken = tokens[0] ?? "";
    if (slug.includes(firstToken) && !fields.includes("slug")) {
      fields.push("slug");
    } else if (
      relativePath.includes(firstToken) &&
      !fields.includes("path")
    ) {
      fields.push("path");
    } else if (title.includes(firstToken) && !fields.includes("title")) {
      fields.push("title");
    } else if (
      tags.some((tag) => tag.includes(firstToken)) &&
      !fields.includes("tags")
    ) {
      fields.push("tags");
    } else if (body.includes(firstToken) && !fields.includes("body")) {
      fields.push("body");
    }
  }
  if (!phraseMatch && matchedTokenCount > 0) {
    value += matchedTokenCount * 25;
    if (fields.length === 0) {
      for (const token of tokens) {
        if (slug.includes(token)) {
          fields.push("slug");
          break;
        }
        if (relativePath.includes(token)) {
          fields.push("path");
          break;
        }
        if (title.includes(token)) {
          fields.push("title");
          break;
        }
        if (tags.some((tag) => tag.includes(token))) {
          fields.push("tags");
          break;
        }
        if (body.includes(token)) {
          fields.push("body");
          break;
        }
      }
    }
  }

  if (fields.length === 0) {
    return null;
  }
  return { value, fields };
}

/** Produces a compact snippet around the first useful query match. */
function makeSnippet(
  file: IndexedMarkdownFile,
  query: string,
  tokens: string[],
): string {
  const source = (file.body.trim() || file.title || file.relativePath)
    .replace(/\s+/gu, " ")
    .trim();
  const normalized = normalize(source);
  let matchIndex = normalized.indexOf(query);
  if (matchIndex < 0) {
    for (const token of tokens) {
      matchIndex = normalized.indexOf(token);
      if (matchIndex >= 0) break;
    }
  }
  if (matchIndex < 0) {
    matchIndex = 0;
  }

  const radiusBefore = 70;
  const radiusAfter = 140;
  const start = Math.max(0, matchIndex - radiusBefore);
  const end = Math.min(source.length, matchIndex + radiusAfter);
  return `${start > 0 ? "…" : ""}${source.slice(start, end).trim()}${
    end < source.length ? "…" : ""
  }`;
}

/** Normalizes fields consistently for search and matching. */
function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

/** Splits a normalized query into searchable words. */
function tokenize(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (token) => token !== "" && !STOP_WORDS.has(token),
    );
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/** Clamps a requested result limit into the supported range. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
