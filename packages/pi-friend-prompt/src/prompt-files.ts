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

/** Prompt configuration with all file-backed text already loaded. */
export interface ResolvedPromptConfig {
  changes: ResolvedPromptChange[];
}

/**
 * Loads every configured prompt source for one request.
 *
 * Relative paths are anchored beside the shared pi-friend configuration so
 * prompt files remain stable regardless of the active project directory.
 */
export async function resolvePromptConfig(
  config: PromptConfig,
): Promise<ResolvedPromptConfig> {
  const baseDirectory = path.dirname(config.configPath);
  const changes = await Promise.all(
    config.changes.map((change, index) =>
      resolveChange(
        change,
        `${config.configPath}: prompt[${index}]`,
        baseDirectory,
      ),
    ),
  );
  return { changes };
}

/** Resolves inline text and ordered files for one prompt change. */
async function resolveChange(
  change: PromptChange,
  location: string,
  baseDirectory: string,
): Promise<ResolvedPromptChange> {
  const fileContents = await Promise.all(
    change.files.map((file, index) =>
      readPromptText(
        resolvePromptPath(file, baseDirectory),
        `${location}.files[${index}]`,
      ),
    ),
  );
  const parts = [change.text, ...fileContents]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.replace(/\r?\n$/, ""));
  const sourceText = parts.join("\n\n");
  if (sourceText.trim() === "") {
    throw new PromptConfigError(
      `${location} resolved to empty prompt text.`,
    );
  }
  return {
    ...change,
    sourceText,
  };
}

/** Reads one UTF-8 prompt file with contextual errors. */
async function readPromptText(
  filePath: string,
  location: string,
): Promise<string> {
  try {
    const contents = await readFile(filePath, "utf8");
    return contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
  } catch (error) {
    throw new PromptConfigError(
      `${location} could not read prompt file ${filePath}.`,
      { cause: error },
    );
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
