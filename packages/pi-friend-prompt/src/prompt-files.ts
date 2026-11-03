/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  PromptConfigError,
  type PromptChange,
  type PromptConfig,
} from "./config.ts";

/** Prompt change with all file-backed source text already loaded. */
export interface ResolvedPromptChange extends PromptChange {
  sourceText: string;
}

/**
 * Prompt configuration with all file-backed text already loaded.
 *
 * `warnings` holds one human-readable message per prompt file that could not be
 * read, plus one per change that was dropped because nothing readable remained.
 * Resolution succeeds despite them; the caller decides how to surface them.
 */
export interface ResolvedPromptConfig {
  changes: ResolvedPromptChange[];
  warnings: string[];
}

/** Outcome of reading one prompt file: its text, or why it was skipped. */
interface PromptFileRead {
  text?: string;
  warning?: string;
}

/** Outcome of resolving one change, keeping warnings aligned with the order. */
interface ResolvedChangeResult {
  change?: ResolvedPromptChange;
  warnings: string[];
}

/**
 * Loads every configured prompt source for one request.
 *
 * Relative paths are anchored beside the shared pi-friend configuration so
 * prompt files remain stable regardless of the active project directory.
 *
 * An unreadable file does not fail the request. It is recorded as a warning and
 * dropped, so the change still applies with whatever text and files remain, and
 * the remaining configured changes still apply too.
 */
export async function resolvePromptConfig(
  config: PromptConfig,
): Promise<ResolvedPromptConfig> {
  const baseDirectory = path.dirname(config.configPath);
  const results = await Promise.all(
    config.changes.map((change, index) =>
      resolveChange(
        change,
        `${config.configPath}: prompt[${index}]`,
        baseDirectory,
      ),
    ),
  );
  return {
    changes: results.flatMap((result) =>
      result.change === undefined ? [] : [result.change],
    ),
    warnings: results.flatMap((result) => result.warnings),
  };
}

/** Resolves inline text and ordered files for one prompt change. */
async function resolveChange(
  change: PromptChange,
  location: string,
  baseDirectory: string,
): Promise<ResolvedChangeResult> {
  const fileReads = await Promise.all(
    change.files.map((file, index) =>
      readPromptText(
        resolvePromptPath(file, baseDirectory),
        `${location}.files[${index}]`,
      ),
    ),
  );
  const warnings = fileReads.flatMap((read) =>
    read.warning === undefined ? [] : [read.warning],
  );
  const fileContents = fileReads.flatMap((read) =>
    read.text === undefined ? [] : [read.text],
  );
  const parts = [change.text, ...fileContents]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.replace(/\r?\n$/, ""));
  const sourceText = parts.join("\n\n");
  if (sourceText.trim() === "") {
    // With an unreadable file this is an expected consequence, not a new
    // configuration error: the file warning above already explains it, so the
    // change is simply dropped instead of aborting every other change.
    if (warnings.length > 0) {
      return {
        warnings: [
          ...warnings,
          `${location}: no prompt text remained after skipping unreadable files, so the change was skipped.`,
        ],
      };
    }
    throw new PromptConfigError(
      `${location} resolved to empty prompt text.`,
    );
  }
  return {
    change: {
      ...change,
      sourceText,
    },
    warnings,
  };
}

/**
 * Reads one UTF-8 prompt file.
 *
 * Any read failure is returned as a warning rather than thrown: a prompt file
 * that is missing, unreadable, or not a file should cost only its own contents.
 */
async function readPromptText(
  filePath: string,
  location: string,
): Promise<PromptFileRead> {
  try {
    const contents = await readFile(filePath, "utf8");
    return {
      text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
    };
  } catch (error) {
    const code = getErrorCode(error);
    const reason =
      code === "ENOENT"
        ? "does not exist"
        : `could not be read${code === undefined ? "" : ` (${code})`}`;
    return {
      warning: `${location}: prompt file ${filePath} ${reason}; skipping that file.`,
    };
  }
}

/** Resolves a prompt path relative to the configuration directory. */
function resolvePromptPath(file: string, baseDirectory: string): string {
  const expanded =
    file === "~"
      ? homedir()
      : file.startsWith("~/")
        ? path.join(homedir(), file.slice(2))
        : file;
  return path.resolve(baseDirectory, expanded);
}

/** Returns a Node filesystem error code without relying on an any cast. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
