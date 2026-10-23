/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { expandHomePath } from "./config.ts";
import {
  buildDocumentIndexEntry,
  type IndexedMarkdownFile,
} from "./indexer.ts";
import type {
  VectorEntryMetadata,
  VectorIndex,
} from "./vector-index.ts";

const IMPORTED_VECTOR_KEY_PREFIX = "external:";
const MAX_IMPORTED_FILES = 10_000;

/** One path prepared for additive semantic indexing. */
export interface IndexPathFiles {
  /** Canonical absolute path supplied to the importer. */
  sourcePath: string;
  files: IndexedMarkdownFile[];
}

/** Error raised when a bulk-index path cannot be used safely. */
export class MemoryIndexPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryIndexPathError";
  }
}

/**
 * Builds searchable entries for a Markdown file or a directory tree.
 *
 * Files under the configured memory root retain their normal memory-relative
 * keys. External files use a stable absolute-path key so repeated imports are
 * upserts rather than duplicate records.
 */
export async function buildIndexPathFiles(
  inputPath: string,
  options: {
    cwd: string;
    memoryRoot: string;
    homeDir?: string;
  },
): Promise<IndexPathFiles> {
  const requested = inputPath.trim();
  if (requested === "") {
    throw new MemoryIndexPathError("Index path must not be empty.");
  }

  const expanded = expandHomePath(requested, options.homeDir ?? homedir());
  const candidate = path.resolve(options.cwd, expanded);
  let sourcePath: string;
  try {
    sourcePath = await realpath(candidate);
  } catch (error) {
    throw new MemoryIndexPathError(
      `Could not resolve index path "${inputPath}".`,
      { cause: error },
    );
  }

  const sourceStat = await stat(sourcePath);
  const markdownPaths: string[] = [];
  if (sourceStat.isFile()) {
    if (!isMarkdownPath(sourcePath)) {
      throw new MemoryIndexPathError(
        `Index path must be a Markdown file or directory: ${sourcePath}`,
      );
    }
    markdownPaths.push(sourcePath);
  } else if (sourceStat.isDirectory()) {
    await collectMarkdownFiles(sourcePath, markdownPaths);
  } else {
    throw new MemoryIndexPathError(
      `Index path is not a regular file or directory: ${sourcePath}`,
    );
  }

  if (markdownPaths.length === 0) {
    throw new MemoryIndexPathError(
      `No Markdown files were found under ${sourcePath}.`,
    );
  }

  const root = await realpath(options.memoryRoot);
  const files: IndexedMarkdownFile[] = [];
  for (const markdownPath of markdownPaths.sort()) {
    files.push(await buildIndexedFile(markdownPath, root));
  }
  return { sourcePath, files };
}

/**
 * Reloads external sources represented in the vector index.
 *
 * Missing files are omitted; a later full synchronization prunes their stale
 * vectors. Other filesystem errors remain visible rather than silently
 * degrading search.
 */
export async function loadImportedIndexedFiles(
  index: VectorIndex,
  memoryRoot: string,
): Promise<IndexedMarkdownFile[]> {
  const files: IndexedMarkdownFile[] = [];
  for (const entry of index.listEntries()) {
    if (!isImportedVectorEntry(entry)) {
      continue;
    }

    try {
      const file = await buildIndexedFile(entry.sourcePath, memoryRoot);
      if (file.vectorKey === entry.key) {
        files.push(file);
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
  }
  return files;
}

/** Returns true when an index entry belongs to an external Markdown file. */
export function isImportedVectorEntry(entry: VectorEntryMetadata): boolean {
  return (
    entry.key.startsWith(IMPORTED_VECTOR_KEY_PREFIX) &&
    path.isAbsolute(entry.sourcePath)
  );
}

/** Recursively collects Markdown files while ignoring symlinks and dot paths. */
async function collectMarkdownFiles(
  directory: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(entryPath, files);
      continue;
    }
    if (!entry.isFile() || !isMarkdownPath(entry.name)) {
      continue;
    }

    files.push(entryPath);
    if (files.length > MAX_IMPORTED_FILES) {
      throw new MemoryIndexPathError(
        `Index path contains more than ${MAX_IMPORTED_FILES} Markdown files.`,
      );
    }
  }
}

/** Reads one Markdown source and attaches fallible import metadata. */
async function buildIndexedFile(
  absolutePath: string,
  memoryRoot: string,
): Promise<IndexedMarkdownFile> {
  const [text, fileStat] = await Promise.all([
    readFile(absolutePath, "utf8"),
    stat(absolutePath),
  ]);
  const internalPath = relativePathWithin(memoryRoot, absolutePath);
  const displayPath =
    internalPath ?? absolutePath.split(path.sep).join("/");
  const file = buildDocumentIndexEntry(
    text,
    absolutePath,
    displayPath,
    "document",
  );

  return {
    ...file,
    ...(internalPath === undefined
      ? { vectorKey: `${IMPORTED_VECTOR_KEY_PREFIX}${displayPath}` }
      : {}),
    modifiedAt: fileStat.mtime.toISOString(),
    provenance: `imported; source: ${displayPath}`,
  };
}

/** Returns a POSIX memory-relative path, or undefined for external files. */
function relativePathWithin(
  root: string,
  target: string,
): string | undefined {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

/** Returns whether a filename has a Markdown extension. */
function isMarkdownPath(value: string): boolean {
  return value.toLowerCase().endsWith(".md");
}

/** Recognizes absent source files without hiding permission failures. */
function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
