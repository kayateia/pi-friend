/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat } from "node:fs/promises";
import * as path from "node:path";

/**
 * The memory layout, declared once.
 *
 * This table is the single source of truth for what the extension owns inside a
 * memory root. Four things derive from it and none of them keep a second copy:
 * {@link createMemoryPaths} builds absolute paths, `ensureMemoryLayout` creates
 * the directories and the log file, the external-index exclusion in
 * `index-exclude.ts` derives the reserved prefixes, and {@link isSearchablePath}
 * tells the store's own walker which Markdown belongs to memory rather than to
 * bookkeeping. Adding or removing a feature that needs storage means editing
 * this table and nothing else; a list kept in parallel would drift, and drift
 * here means either importing the extension's own files, hiding a directory it
 * no longer owns, or indexing its own receipts.
 *
 * `searchable` is not about secrecy: it separates "this file is memory" from
 * "this file is a record of what happened to memory". Sweep logs, preimages,
 * dropped and archived candidates, the vector index, recovery records and the
 * history tree are all useful to a person reading the tree with `ls`, and none
 * of them should answer a memory search — a preimage especially, since it is a
 * full copy of the store from before a change.
 */
export const MEMORY_LAYOUT = {
  nodes: { relativePath: "nodes", kind: "directory", searchable: true },
  supersededNodes: {
    relativePath: "nodes/superseded",
    kind: "directory",
    searchable: true,
  },
  staging: { relativePath: "staging", kind: "directory", searchable: true },
  history: { relativePath: "history", kind: "directory", searchable: false },
  sweeps: { relativePath: "sweeps", kind: "directory", searchable: false },
  index: { relativePath: "index", kind: "directory", searchable: false },
  recovery: { relativePath: "recovery", kind: "directory", searchable: false },
  accessLog: { relativePath: "access-log", kind: "file", searchable: false },
} as const satisfies Record<
  string,
  { relativePath: string; kind: "directory" | "file"; searchable: boolean }
>;

/** One entry name in {@link MEMORY_LAYOUT}. */
export type MemoryLayoutEntry = keyof typeof MEMORY_LAYOUT;

/** Canonical locations inside one configured memory tree. */
export type MemoryPaths = {
  configPath: string;
  root: string;
} & Record<MemoryLayoutEntry, string>;

/** How a Markdown file participates in the memory system. */
export type MemoryFileKind = "node" | "staging-candidate" | "document";

/** Error raised when a path or slug would escape the memory tree. */
export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPathError";
  }
}

/** Builds the complete canonical path model for a memory root. */
export function createMemoryPaths(root: string, configPath: string): MemoryPaths {
  const resolvedRoot = path.resolve(root);
  const entries = Object.entries(MEMORY_LAYOUT) as Array<
    [MemoryLayoutEntry, { relativePath: string }]
  >;
  const layout = Object.fromEntries(
    entries.map(([name, entry]) => [
      name,
      path.join(
        resolvedRoot,
        entry.relativePath.split("/").join(path.sep),
      ),
    ]),
  ) as Record<MemoryLayoutEntry, string>;

  return { configPath, root: resolvedRoot, ...layout };
}

/**
 * Returns true when a memory-relative path holds searchable memory.
 *
 * Top-level directories the layout marks unsearchable are bookkeeping: their
 * Markdown is never enumerated as a node, candidate or document. Deeper paths
 * inherit their top-level segment, so `sweeps/preimages/<run>/nodes/x.md` is
 * unsearchable even though it looks like a node path.
 */
export function isSearchablePath(relativePath: string): boolean {
  const topLevel = relativePath.split(/[\\/]+/u)[0] ?? relativePath;
  for (const entry of Object.values(MEMORY_LAYOUT)) {
    if (entry.relativePath === topLevel) {
      return entry.searchable;
    }
  }
  return true;
}

/** Validates a lowercase hyphenated memory-node slug. */
export function validateSlug(slug: string): string {
  if (
    slug.length === 0 ||
    slug.length > 120 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  ) {
    throw new MemoryPathError(
      "Slug must use lowercase letters, digits, and single hyphens.",
    );
  }

  return slug;
}

/**
 * Resolves a memory-relative path and verifies the result remains under root.
 */
export function resolveWithin(root: string, relativePath: string): string {
  if (relativePath.trim() === "" || relativePath.includes("\0")) {
    throw new MemoryPathError("Memory-relative paths must not be empty.");
  }

  // Treat both slash styles as separators so Windows-style traversal is
  // rejected consistently on every platform.
  const portablePath = relativePath.split(/[\\/]+/).join(path.sep);
  if (path.isAbsolute(portablePath)) {
    throw new MemoryPathError("Absolute paths are not allowed in memory storage.");
  }
  if (portablePath.split(path.sep).includes("..")) {
    throw new MemoryPathError("Parent-directory segments are not allowed in memory storage.");
  }

  const resolved = path.resolve(root, portablePath);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new MemoryPathError("Path escapes the configured memory root.");
  }

  return resolved;
}

/** Converts an absolute path under root to its stable POSIX-style key. */
export function relativeKey(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new MemoryPathError("Path is outside the configured memory root.");
  }

  return relative.split(path.sep).join("/");
}

/** Classifies a Markdown file using its location, not its front matter. */
export function classifyMemoryMarkdown(relativePath: string): MemoryFileKind {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.startsWith("nodes/")) {
    return "node";
  }

  if (normalized.startsWith("staging/")) {
    return "staging-candidate";
  }

  return "document";
}

/**
 * Rejects symbolic links in every existing segment between root and target.
 *
 * The configured root itself may be a symlink; callers should pass its
 * canonical realpath here. Missing segments are accepted for new files.
 */
export async function assertNoSymlinkSegments(
  root: string,
  targetPath: string,
): Promise<void> {
  const relative = path.relative(root, targetPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new MemoryPathError("Path is outside the configured memory root.");
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (segment === "") {
      continue;
    }

    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new MemoryPathError(`Symbolic links are not allowed: ${current}`);
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return;
      }

      throw error;
    }
  }
}

/** Returns a Node filesystem error code without relying on an any cast. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
