/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import { MEMORY_LAYOUT } from "./paths.ts";

/**
 * Decides which paths a configured `index_paths` entry must not import.
 *
 * Two sources of exclusion, treated the same way: the paths the extension owns
 * inside its memory root, and user-configured `index_exclude` globs. A path is
 * excluded when it is one of the reserved paths the extension writes itself, or
 * when it matches a pattern directly or through one of its ancestors — so
 * excluding a directory excludes everything below it without needing a second
 * pattern.
 *
 * The whole memory root is deliberately *not* excluded: only the directories and
 * files that have special meaning are. Anything else someone keeps beside the
 * store is ordinary Markdown and may be indexed, which keeps the exclusion from
 * growing into a rule that quietly hides a directory the user meant to expose.
 *
 * There is no maintenance step here, by design: the reserved set is derived from
 * `MEMORY_LAYOUT`, the same table `createMemoryPaths` and `ensureMemoryLayout`
 * read. A layout change therefore changes what is excluded in the same edit,
 * and cannot leave two lists disagreeing about what the extension owns.
 */

/**
 * Paths under the memory root that the extension reads and writes itself.
 *
 * Derived from {@link MEMORY_LAYOUT} rather than listed again: the table is the
 * single declaration of what the extension owns, so a feature that adds storage
 * is excluded from external indexing the moment its path is declared, and one
 * that removes storage stops being excluded without anyone remembering to edit a
 * second list. Entries are reduced to their top-level segment, so `nodes/`
 * covers `nodes/superseded/` while a sibling directory called `nodes-archive/`
 * stays indexable.
 */
export const RESERVED_MEMORY_PATHS: readonly string[] = [
  ...new Set(
    Object.values(MEMORY_LAYOUT).map(
      (entry) => entry.relativePath.split("/")[0] ?? entry.relativePath,
    ),
  ),
].sort();

/** One compiled `index_exclude` entry. */
export interface CompiledExclude {
  /** The configured text, kept for diagnostics. */
  source: string;
  /** Anchored expression matched against POSIX-style absolute paths. */
  pattern: RegExp;
}

/**
 * Compiles one glob pattern.
 *
 * Supported syntax is deliberately small and documented: `**` crosses directory
 * separators, `*` matches within one path segment, and `?` matches one non-slash
 * character. Everything else is literal, so a pattern that contains no wildcard
 * is an exact path.
 */
export function compileExcludePattern(source: string): CompiledExclude {
  const normalized = toPosix(source.trim());
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          // `**/` may match no directory at all, so it stays optional.
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
        continue;
      }
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += escapeRegExp(character);
  }
  return {
    source,
    pattern: new RegExp(`^${expression}$`, "u"),
  };
}

/** Compiles every configured exclusion in order. */
export function compileExcludePatterns(
  sources: readonly string[],
): CompiledExclude[] {
  return sources.map(compileExcludePattern);
}

/**
 * Returns true when a candidate path must not be imported.
 *
 * Being inside the memory root is not enough: the store's own directories are
 * excluded because importing them duplicates content the extension already
 * indexes, and because every memory write would otherwise churn the external
 * index. Neighbouring content under the same root stays indexable.
 */
export function isExcludedPath(
  candidate: string,
  memoryRoot: string,
  excludes: readonly CompiledExclude[],
): boolean {
  const target = toPosix(path.resolve(candidate));
  const root = toPosix(path.resolve(memoryRoot));

  for (const reserved of RESERVED_MEMORY_PATHS) {
    const owned = `${root}/${reserved}`;
    if (target === owned || target.startsWith(`${owned}/`)) {
      return true;
    }
  }

  let current = target;
  for (;;) {
    if (excludes.some((exclude) => exclude.pattern.test(current))) {
      return true;
    }
    const parent = path.posix.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/** Normalizes platform separators for consistent pattern matching. */
function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Escapes one character for literal use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
