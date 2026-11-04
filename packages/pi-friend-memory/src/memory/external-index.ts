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
  isExcludedPath,
  type CompiledExclude,
} from "./index-exclude.ts";
import {
  buildDocumentIndexEntry,
  type IndexedMarkdownFile,
} from "./indexer.ts";
import type { VectorEntryMetadata } from "./vector-index.ts";

const IMPORTED_VECTOR_KEY_PREFIX = "external:";
const MAX_IMPORTED_FILES = 10_000;

/** One path prepared for additive semantic indexing. */
export interface IndexPathFiles {
  /** Canonical absolute path supplied to the importer. */
  sourcePath: string;
  files: IndexedMarkdownFile[];
}

/** Error raised when an external-index path cannot be used safely. */
export class ExternalIndexPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalIndexPathError";
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
    /** Allows a configured directory to contain no Markdown files yet. */
    allowEmpty?: boolean;
    /** Compiled `index_exclude` patterns, in configuration order. */
    exclude?: readonly CompiledExclude[];
  },
): Promise<IndexPathFiles> {
  const requested = inputPath.trim();
  if (requested === "") {
    throw new ExternalIndexPathError("Index path must not be empty.");
  }

  const expanded = expandHomePath(requested, options.homeDir ?? homedir());
  const candidate = path.resolve(options.cwd, expanded);
  let sourcePath: string;
  try {
    sourcePath = await realpath(candidate);
  } catch (error) {
    throw new ExternalIndexPathError(
      `Could not resolve index path "${inputPath}".`,
      { cause: error },
    );
  }

  const root = await realpath(options.memoryRoot);
  const exclude = options.exclude ?? [];
  const isExcluded = (candidate: string): boolean =>
    isExcludedPath(candidate, root, exclude);

  const sourceStat = await stat(sourcePath);
  const markdownPaths: string[] = [];
  if (sourceStat.isFile()) {
    if (!isMarkdownPath(sourcePath)) {
      throw new ExternalIndexPathError(
        `Index path must be a Markdown file or directory: ${sourcePath}`,
      );
    }
    if (!isExcluded(sourcePath)) {
      markdownPaths.push(sourcePath);
    }
  } else if (sourceStat.isDirectory()) {
    await collectMarkdownFiles(sourcePath, markdownPaths, isExcluded);
  } else {
    throw new ExternalIndexPathError(
      `Index path is not a regular file or directory: ${sourcePath}`,
    );
  }

  if (markdownPaths.length === 0 && options.allowEmpty !== true) {
    throw new ExternalIndexPathError(
      `No Markdown files were found under ${sourcePath}.`,
    );
  }

  const files: IndexedMarkdownFile[] = [];
  for (const markdownPath of markdownPaths.sort()) {
    files.push(await buildIndexedFile(markdownPath, root));
  }
  return { sourcePath, files };
}

/** Returns true when an index entry belongs to an external Markdown file. */
export function isImportedVectorEntry(entry: VectorEntryMetadata): boolean {
  return (
    entry.key.startsWith(IMPORTED_VECTOR_KEY_PREFIX) &&
    path.isAbsolute(entry.sourcePath)
  );
}

/**
 * Recursively collects Markdown files while ignoring symlinks, dot paths, and
 * anything the exclusion predicate rejects. Directories are tested before they
 * are entered, so an excluded tree is never walked at all.
 */
async function collectMarkdownFiles(
  directory: string,
  files: string[],
  isExcluded: (candidate: string) => boolean,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (isExcluded(entryPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectMarkdownFiles(entryPath, files, isExcluded);
      continue;
    }
    if (!entry.isFile() || !isMarkdownPath(entry.name)) {
      continue;
    }

    files.push(entryPath);
    if (files.length > MAX_IMPORTED_FILES) {
      throw new ExternalIndexPathError(
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
