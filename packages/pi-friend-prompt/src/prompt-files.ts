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
  type PromptConfig,
  type PromptReplacement,
  type PromptSource,
} from "./config.ts";

/** Replacement rule with all file-backed text already loaded. */
export interface ResolvedPromptReplacement extends PromptReplacement {
  replacementText: string;
}

/** Prompt configuration with all file-backed text already loaded. */
export interface ResolvedPromptConfig {
  custom?: string;
  addendum?: string;
  sections: Record<string, string>;
  replacements: ResolvedPromptReplacement[];
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
  const [custom, addendum, sections, replacements] = await Promise.all([
    resolveOptionalSource(
      config.custom,
      `${config.configPath}: prompt.custom`,
      baseDirectory,
    ),
    resolveOptionalSource(
      config.addendum,
      `${config.configPath}: prompt.addendum`,
      baseDirectory,
    ),
    resolveSections(config, baseDirectory),
    resolveReplacements(config.replacements, config.configPath, baseDirectory),
  ]);

  return {
    ...(custom === undefined ? {} : { custom }),
    ...(addendum === undefined ? {} : { addendum }),
    sections,
    replacements,
  };
}

/** Resolves the inline text and ordered files for one prompt slot. */
async function resolveOptionalSource(
  source: PromptSource | undefined,
  location: string,
  baseDirectory: string,
): Promise<string | undefined> {
  if (source === undefined) {
    return undefined;
  }

  const fileContents = await Promise.all(
    source.files.map((file, index) =>
      readPromptText(
        resolvePromptPath(file, baseDirectory),
        `${location}.files[${index}]`,
      ),
    ),
  );
  const parts = [source.text, ...fileContents]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** Resolves all configured custom prompt sections. */
async function resolveSections(
  config: PromptConfig,
  baseDirectory: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(config.sections).map(async ([name, source]) => {
      const text = await resolveOptionalSource(
        source,
        `${config.configPath}: prompt.sections.${name}`,
        baseDirectory,
      );
      return text === undefined ? undefined : ([name, text] as const);
    }),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, string] =>
      entry !== undefined
    ),
  );
}

/** Resolves the replacement text for every prompt replacement rule. */
async function resolveReplacements(
  replacements: PromptReplacement[],
  configPath: string,
  baseDirectory: string,
): Promise<ResolvedPromptReplacement[]> {
  return Promise.all(
    replacements.map(async (replacement, index) => {
      const location = `${configPath}: prompt.replacements[${index}]`;
      let replacementText = replacement.replacement;
      if (replacement.replacementFile !== undefined) {
        replacementText = await readPromptText(
          resolvePromptPath(replacement.replacementFile, baseDirectory),
          `${location}.replacement_file`,
        );
      }
      if (replacementText === undefined) {
        throw new PromptConfigError(
          `${location} did not resolve replacement text.`,
        );
      }
      return {
        ...replacement,
        replacementText,
      };
    }),
  );
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
