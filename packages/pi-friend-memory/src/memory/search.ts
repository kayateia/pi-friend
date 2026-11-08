/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IndexedMarkdownFile } from "./indexer.ts";
import type { MemoryFileKind } from "./paths.ts";
import type { MemorySpeaker } from "./schema.ts";
import type {
  MemoryStatus,
  MemoryType,
} from "./schema.ts";

/** Supported search modes for the initial implementation. */
export type MemorySearchMode = "keyword" | "semantic" | "hybrid";

/**
 * Which part of the index a search should consider.
 *
 * `memory` is what recall injects — nodes and staging candidates. `documents` is
 * everything else that is searchable: imported Markdown and the store's own
 * ordinary documents. `all` is both, and remains the default so a plain search
 * behaves as it always has.
 */
export type MemorySearchCorpus = "all" | "memory" | "documents";

/** Maps a corpus to the file kinds it covers. */
export function kindsForCorpus(
  corpus: MemorySearchCorpus,
): readonly MemoryFileKind[] {
  switch (corpus) {
    case "memory":
      return ["node", "staging-candidate"];
    case "documents":
      return ["document"];
    case "all":
      return ["node", "staging-candidate", "document"];
  }
}

/** Input for a keyword search over indexed Markdown files. */
export interface MemorySearchOptions {
  query: string;
  mode?: MemorySearchMode;
  type?: MemoryType;
  kind?: IndexedMarkdownFile["kind"];
  kinds?: readonly MemoryFileKind[];
  /** Convenience alternative to `kinds`; supplying both is an error. */
  corpus?: MemorySearchCorpus;
  status?: MemoryStatus;
  statuses?: readonly MemoryStatus[];
  limit?: number;
  /** Minimum meaningful token overlap when no phrase match occurs. */
  minTokenMatches?: number;
  /**
   * Names that arrived in a speaker tag. They are not part of the query text —
   * a tag is not something that was said — but a memory attributed to one of
   * them is more relevant to the person speaking, so it scores once for each.
   */
  speakerNames?: readonly string[];
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
  /** Attribution recorded on the node; absent for documents. */
  speaker?: readonly MemorySpeaker[];
  modifiedAt?: string;
  provenance?: string;
  snippet: string;
  score: number;
  matchedFields: SearchField[];
  /** Raw keyword score before hybrid fusion; absent for semantic-only results. */
  keywordScore?: number;
  /** How that score was earned, in points per field, largest first. */
  keywordContributions?: ReadonlyArray<{ field: SearchField; points: number }>;
  /** Semantic similarity (1 − distance); absent for keyword-only results. */
  semanticScore?: number;
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
  | "speaker"
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
    if (options.kind !== undefined && file.kind !== options.kind) {
      continue;
    }
    if (
      options.kinds !== undefined &&
      !options.kinds.includes(file.kind)
    ) {
      continue;
    }
    if (options.status !== undefined && file.status !== options.status) {
      continue;
    }
    if (
      options.statuses !== undefined &&
      (file.status === undefined ||
        !options.statuses.includes(file.status))
    ) {
      continue;
    }

    const score = scoreFile(
      file,
      query,
      queryTokens,
      options.minTokenMatches,
      (options.speakerNames ?? []).map(normalize),
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
      ...(file.speaker === undefined ? {} : { speaker: file.speaker }),
      ...(file.modifiedAt === undefined
        ? {}
        : { modifiedAt: file.modifiedAt }),
      ...(file.provenance === undefined
        ? {}
        : { provenance: file.provenance }),
      snippet: makeSnippet(file, query, queryTokens),
      score: score.value,
      matchedFields: score.fields,
      keywordScore: score.value,
      keywordContributions: score.contributions,
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
    .slice(0, limit)
    .map((result, index) => ({
      ...result,
      keywordRank: index + 1,
    }));
}

/** Explains the retrieval signals behind one model-facing search result. */
export function formatRetrievalExplanation(
  result: MemorySearchResult,
): string {
  const details: string[] = [];
  if (result.semanticRank !== undefined) {
    details.push(`semantic rank #${result.semanticRank}`);
  }
  if (result.keywordRank !== undefined) {
    details.push(`keyword rank #${result.keywordRank}`);
  }

  const keywordFields = result.matchedFields.filter(
    (field) => field !== "semantic",
  );
  if (keywordFields.length > 0) {
    details.push(`matched fields: ${keywordFields.join(", ")}`);
  } else if (
    result.matchedFields.includes("semantic") &&
    result.semanticRank === undefined
  ) {
    details.push("semantic match");
  }
  details.push(`score ${result.score.toFixed(4)}`);

  return `Why recalled: ${details.join(" · ")}`;
}

/** Scores one indexed file, or returns null when no query field matches. */
function scoreFile(
  file: IndexedMarkdownFile,
  query: string,
  tokens: string[],
  minTokenMatches: number | undefined,
  taggedNames: string[],
): {
  value: number;
  fields: SearchField[];
  contributions: Array<{ field: SearchField; points: number }>;
} | null {
  const slug = normalize(file.slug ?? "");
  const relativePath = normalize(file.relativePath);
  const title = normalize(file.title ?? "");
  const tags = file.tags.map(normalize);
  const body = normalize(file.body);
  const haystack = [slug, relativePath, title, tags.join(" "), body].join("\n");

  const fields: SearchField[] = [];
  const contributions: Array<{ field: SearchField; points: number }> = [];
  let value = 0;
  let phraseMatch = false;
  /** Records points against a field, both in the total and in the breakdown. */
  const award = (field: SearchField, points: number): void => {
    value += points;
    contributions.push({ field, points });
  };

  if (slug === query) {
    award("slug", 1_000);
    fields.push("slug");
    phraseMatch = true;
  } else if (slug.includes(query)) {
    award("slug", 500);
    fields.push("slug");
    phraseMatch = true;
  }

  if (relativePath.includes(query)) {
    award("path", 350);
    if (!fields.includes("path")) fields.push("path");
    phraseMatch = true;
  }

  if (title === query) {
    award("title", 900);
    fields.push("title");
    phraseMatch = true;
  } else if (title.includes(query)) {
    award("title", 650);
    fields.push("title");
    phraseMatch = true;
  }

  if (tags.includes(query)) {
    award("tags", 600);
    fields.push("tags");
    phraseMatch = true;
  } else if (tags.some((tag) => tag.includes(query))) {
    award("tags", 400);
    fields.push("tags");
    phraseMatch = true;
  }

  // Attribution is content in a plural system, so a name a person asked about
  // may match a memory that never says it in prose. Each distinct speaker
  // contributes once, however many times that name is recorded, so a node with
  // three `Aria` records scores exactly like one with a single record.
  const speakers = [
    ...new Set(
      (file.speaker ?? [])
        .map((speaker) => normalize(speaker.name))
        .filter((name) => name !== ""),
    ),
  ];
  let speakerMatched = false;
  for (const name of speakers) {
    if (taggedNames.includes(name)) {
      // The person speaking is in this conversation. Score the memory once for
      // it, and never let it open the gate: the name was not something they
      // said, so it cannot make an unrelated memory relevant on its own.
      award("speaker", 600);
      speakerMatched = true;
    } else if (name === query) {
      award("speaker", 600);
      speakerMatched = true;
      // Naming only a person is a phrase match: the memory is *about* them.
      phraseMatch = true;
    } else if (tokens.includes(name)) {
      award("speaker", 250);
      speakerMatched = true;
    }
  }
  if (speakerMatched) {
    fields.push("speaker");
  }

  if (body.includes(query)) {
    award("body", 200);
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
    award("body", 50);
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
    award("body", matchedTokenCount * 25);
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
  contributions.sort((left, right) => right.points - left.points);
  return { value, fields, contributions };
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
