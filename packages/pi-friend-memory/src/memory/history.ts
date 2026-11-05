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

/** Kinds that keep a directory of timestamped versions per slug. */
export const VERSIONED_HISTORY_KINDS: readonly HistoryKind[] = [
  "edited",
  "merged",
  "split",
];

/**
 * Returns the sortable part of a version path.
 *
 * Version files are named `…/<slug>/<timestamp>.md`, so the file name is the
 * ordering key and lexical comparison is chronological.
 */
export function versionTimestamp(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? "";
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

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

/** What one retention pass removed, and what it could not remove. */
export interface HistoryPruneResult {
  removed: number;
  failed: string[];
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Deletes history files older than `memory.history.keep_days`.
 *
 * Runs at sweep time rather than on every message: a sweep already walks the
 * store once a day, and retention is not urgent enough to scan directories on a
 * chat turn. Writes prune their own slug as they go, which is one directory
 * lookup rather than a tree walk.
 *
 * `keepDays` of 0 keeps everything. The returned count is what the sweep log
 * reports; individual failures are collected rather than thrown, so one
 * unreadable file does not stop the rest of the pass.
 */
export async function pruneHistory(
  store: MemoryStore,
  now: Date = new Date(),
): Promise<HistoryPruneResult> {
  const keepDays = store.config.history.keepDays;
  if (keepDays <= 0) {
    return { removed: 0, failed: [] };
  }
  const cutoff = now.getTime() - keepDays * DAY_MS;
  const result: HistoryPruneResult = { removed: 0, failed: [] };

  for (const kind of VERSIONED_HISTORY_KINDS) {
    for (const directory of await store.listDirectories(`history/${kind}`)) {
      const pruned = await pruneVersionsIn(store, directory, cutoff);
      result.removed += pruned.removed;
      result.failed.push(...pruned.failed);
      if (pruned.removed > 0) {
        await store.removeDirectoryIfEmpty(directory).catch(() => false);
      }
    }
  }

  for (const kind of ["deleted", "dropped"] as const) {
    for (const relativePath of await store.listDirectoryMarkdown(
      `history/${kind}`,
    )) {
      try {
        const modified = await store.fileModifiedAt(relativePath);
        if (modified !== null && modified.getTime() < cutoff) {
          await store.removeTextFile(relativePath);
          result.removed += 1;
        }
      } catch (error) {
        result.failed.push(`${relativePath}: ${describeError(error)}`);
      }
    }
  }

  return result;
}

/**
 * Prunes one slug's stored versions, called after a version is written.
 *
 * Only that slug's directory is read, so editing a memory does not pay for the
 * size of `history/`.
 */
export async function pruneHistorySlug(
  store: MemoryStore,
  kind: HistoryKind,
  slug: string,
  now: Date = new Date(),
): Promise<number> {
  const keepDays = store.config.history.keepDays;
  if (keepDays <= 0 || !VERSIONED_HISTORY_KINDS.includes(kind)) {
    return 0;
  }
  const directory = `history/${kind}/${validateSlug(slug)}`;
  const cutoff = now.getTime() - keepDays * DAY_MS;
  const pruned = await pruneVersionsIn(store, directory, cutoff);
  if (pruned.removed > 0) {
    await store.removeDirectoryIfEmpty(directory).catch(() => false);
  }
  return pruned.removed;
}

/** Removes expired version files inside one slug directory. */
async function pruneVersionsIn(
  store: MemoryStore,
  directory: string,
  cutoff: number,
): Promise<{ removed: number; failed: string[] }> {
  let removed = 0;
  const failed: string[] = [];
  let files: string[];
  try {
    files = await store.listDirectoryMarkdown(directory);
  } catch (error) {
    return { removed, failed: [`${directory}: ${describeError(error)}`] };
  }
  for (const relativePath of files) {
    const captured = Date.parse(versionTimestamp(relativePath));
    if (!Number.isFinite(captured) || captured >= cutoff) {
      continue;
    }
    try {
      await store.removeTextFile(relativePath);
      removed += 1;
    } catch (error) {
      failed.push(`${relativePath}: ${describeError(error)}`);
    }
  }
  return { removed, failed };
}

/** Formats an error's message without assuming its shape. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
