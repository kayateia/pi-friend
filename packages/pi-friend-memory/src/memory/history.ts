/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryStore } from "./store.ts";
import type { ParsedMemoryNode } from "./schema.ts";
import { parseMemoryNode, serializeMemoryNode } from "./schema.ts";
import { MemoryPathError, validateSlug } from "./paths.ts";

/**
 * What a stored previous version records.
 *
 * `deleted` and `dropped` are one file per slug, because a node can only end
 * once per kind. `edited`, `merged` and `split` are one directory per slug
 * holding timestamped versions, because a node can be edited many times and
 * each version has to stay addressable.
 */
export type HistoryKind =
  | "deleted"
  | "dropped"
  | "edited"
  | "merged"
  | "split";

/** Kinds that keep a single file named after the slug. */
const SINGLE_FILE_KINDS: ReadonlySet<HistoryKind> = new Set([
  "deleted",
  "dropped",
]);

/** Timestamps used as file names: ISO 8601 with milliseconds, no offsets. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Builds the path of one history entry.
 *
 * Timestamps are the operation's own `toISOString()` value, so they sort
 * lexicographically in the order the versions were replaced — the newest file
 * in a directory is the most recent version that is no longer current.
 */
export function historyEntryPath(
  kind: HistoryKind,
  slug: string,
  timestamp?: string,
): string {
  const validSlug = validateSlug(slug);
  if (SINGLE_FILE_KINDS.has(kind)) {
    return `history/${kind}/${validSlug}.md`;
  }
  if (timestamp === undefined || !TIMESTAMP_PATTERN.test(timestamp)) {
    throw new MemoryPathError(
      `history/${kind}/${validSlug} needs an ISO timestamp file name.`,
    );
  }
  return `history/${kind}/${validSlug}/${timestamp}.md`;
}

/**
 * Removes the history-only fields from a front-matter record.
 *
 * Used by restore: the file is a copy of a live node plus what happened to it,
 * and the "what happened" part must not come back with it.
 */
export function stripHistoryFields<
  T extends {
    history_reason?: string;
    history_conflict?: string;
    history_children?: string[];
  },
>(frontMatter: T): T {
  const { history_reason, history_conflict, history_children, ...rest } =
    frontMatter;
  void history_reason;
  void history_conflict;
  void history_children;
  return rest as T;
}

/** Writes one previous version and returns its relative path. */
export async function writeHistoryEntry(
  store: MemoryStore,
  entry: {
    kind: HistoryKind;
    slug: string;
    timestamp?: string;
    node: ParsedMemoryNode;
  },
): Promise<string> {
  const relativePath = historyEntryPath(entry.kind, entry.slug, entry.timestamp);
  await store.writeTextFile(relativePath, serializeMemoryNode(entry.node));
  return relativePath;
}

/**
 * Reads one history entry, or null when the file is absent.
 *
 * The slug is supplied rather than derived: a version file is named after the
 * moment it stopped being current, not after the memory, so the file name alone
 * does not identify it.
 */
export async function readHistoryEntry(
  store: MemoryStore,
  relativePath: string,
  slug: string,
): Promise<ParsedMemoryNode | null> {
  const text = await store.readTextFileIfExists(relativePath);
  if (text === null) {
    return null;
  }
  // History entries are copies of nodes in whatever state they were in —
  // including `candidate` for a dropped or merged staging candidate — so they
  // are parsed without the status rules that apply to live areas.
  return parseMemoryNode(text, slug, undefined, { allowHistoryFields: true });
}

/**
 * Lists one slug's stored versions, oldest first.
 *
 * Names are ISO timestamps, so sorting the directory listing sorts by time.
 */
export async function listHistoryVersions(
  store: MemoryStore,
  kind: HistoryKind,
  slug: string,
): Promise<string[]> {
  const validSlug = validateSlug(slug);
  if (SINGLE_FILE_KINDS.has(kind)) {
    const relativePath = `history/${kind}/${validSlug}.md`;
    const text = await store.readTextFileIfExists(relativePath);
    return text === null ? [] : [relativePath];
  }
  return store.listDirectoryMarkdown(`history/${kind}/${validSlug}`);
}
