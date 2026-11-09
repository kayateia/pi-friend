/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseMemoryNode, type ParsedMemoryNode } from "./schema.ts";
import type { MemoryStore } from "./store.ts";

/**
 * Areas a stored memory can live in, and which the validator walks.
 *
 * `history/` is included because a version that does not parse is a restore that
 * will fail later, at the worst moment — when someone is already trying to undo
 * something.
 */
export const STORED_MEMORY_DIRECTORIES = ["nodes", "staging", "history"] as const;

/** One of the areas the validator walks. */
export type StoredMemoryDirectory = (typeof STORED_MEMORY_DIRECTORIES)[number];

/** One file that could not be parsed, and what the parser said. */
export interface MemoryValidationFailure {
  path: string;
  error: string;
}

/** Result of checking every stored memory in the store. */
export interface MemoryValidationReport {
  scanned: number;
  failures: MemoryValidationFailure[];
}

/**
 * Parses every stored memory and history version, collecting every failure.
 *
 * Listing an area normally rejects on the first bad file, which is why a damaged
 * memory surfaces as "the sweep failed" rather than as "this file is damaged".
 * A validator is the opposite job: keep going, name each one, and say how many
 * files were fine so the answer reads as a check rather than a scare.
 */
export async function validateMemoryFiles(
  store: MemoryStore,
): Promise<MemoryValidationReport> {
  let scanned = 0;
  const failures: MemoryValidationFailure[] = [];

  for (const directory of STORED_MEMORY_DIRECTORIES) {
    for (const relativePath of await listStoredMemoryFiles(store, directory)) {
      scanned += 1;
      try {
        const text = await store.readTextFile(relativePath);
        parseStoredMemoryFile(text, relativePath, directory);
      } catch (error) {
        failures.push({ path: relativePath, error: formatError(error) });
      }
    }
  }

  return { scanned, failures };
}

/** Lists every Markdown file under one stored-memory area, recursively. */
export async function listStoredMemoryFiles(
  store: MemoryStore,
  directory: string,
): Promise<string[]> {
  const files = await store.listDirectoryMarkdown(directory);
  for (const child of await store.listDirectories(directory)) {
    files.push(...(await listStoredMemoryFiles(store, child)));
  }
  return files;
}

/**
 * Parses one stored file the way its area is normally parsed.
 *
 * History holds a node in whatever state it was in — including `candidate` for a
 * dropped or merged staging candidate — so it is parsed with the history fields
 * allowed and without the live areas' status rules.
 */
export function parseStoredMemoryFile(
  text: string,
  relativePath: string,
  directory: StoredMemoryDirectory,
): ParsedMemoryNode {
  const slug = slugForStoredPath(relativePath);
  if (directory === "history") {
    return parseMemoryNode(text, slug, undefined, { allowHistoryFields: true });
  }
  return parseMemoryNode(text, slug);
}

/**
 * Derives the slug a stored file belongs to.
 *
 * History versions are named after the moment they stopped being current, so the
 * slug comes from the directory above them; a deleted or dropped entry keeps the
 * slug as its file name.
 */
export function slugForStoredPath(relativePath: string): string {
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  const stem = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const versioned = segments.length >= 4 && segments[0] === "history";
  return versioned ? (segments.at(-2) ?? stem) : stem;
}

/**
 * Formats a validation report for a person reading a toast.
 *
 * Names up to twenty failures: past that the message stops being read, and the
 * count carries the rest.
 */
export function formatValidationReport(report: MemoryValidationReport): string {
  if (report.failures.length === 0) {
    return `pi-friend memory: ${report.scanned} file${report.scanned === 1 ? "" : "s"} checked, all valid.`;
  }

  const shown = report.failures.slice(0, 20);
  const lines = [
    `pi-friend memory: ${report.scanned} file${report.scanned === 1 ? "" : "s"} checked, ${report.failures.length} could not be parsed.`,
    ...shown.map((failure) => `${failure.path}: ${failure.error}`),
  ];
  if (report.failures.length > shown.length) {
    lines.push(`… and ${report.failures.length - shown.length} more.`);
  }
  return lines.join("\n");
}

/** Returns a short message for a failure, without a stack. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
