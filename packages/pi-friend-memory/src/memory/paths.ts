/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat } from "node:fs/promises";
import * as path from "node:path";

/** Canonical locations inside one configured memory tree. */
export interface MemoryPaths {
  configPath: string;
  root: string;
  topOfMind: string;
  nodes: string;
  supersededNodes: string;
  staging: string;
  accessLog: string;
  sweeps: string;
  index: string;
  recovery: string;
}

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

  return {
    configPath,
    root: resolvedRoot,
    topOfMind: path.join(resolvedRoot, "MEMORY.md"),
    nodes: path.join(resolvedRoot, "nodes"),
    supersededNodes: path.join(resolvedRoot, "nodes", "superseded"),
    staging: path.join(resolvedRoot, "staging"),
    accessLog: path.join(resolvedRoot, "access-log"),
    sweeps: path.join(resolvedRoot, "sweeps"),
    index: path.join(resolvedRoot, "index"),
    recovery: path.join(resolvedRoot, "recovery"),
  };
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
