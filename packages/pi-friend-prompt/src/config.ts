/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

/** How source text is combined with a prompt section. */
export type PromptAction = "replace" | "prepend" | "append";

/** One ordered change to a system-prompt section. */
export interface PromptChange {
  section: string;
  action: PromptAction;
  text?: string;
  files: string[];
  pattern?: string;
  flags: string;
}

/** Prompt settings extracted from the shared pi-friend YAML file. */
export interface PromptConfig {
  configPath: string;
  changes: PromptChange[];
}

/** Inputs for alternate Pi agent directories or explicit config paths. */
export interface PromptConfigOptions {
  agentDir?: string;
  configPath?: string;
}

/** Error raised for malformed prompt configuration. */
export class PromptConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptConfigError";
  }
}

/** Returns the dedicated pi-friend-prompt configuration path. */
export function getPromptConfigPath(
  agentDir: string = getAgentDir(),
): string {
  return path.join(agentDir, "pi-friend", "pi-friend-prompt.yml");
}

/** Parses the ordered `prompt` changes while ignoring other sections. */
export function parsePromptConfig(
  source: string,
  configPath: string,
): PromptConfig {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new PromptConfigError(`Could not parse ${configPath}.`, {
      cause: error,
    });
  }

  if (document === null || document === undefined) {
    return emptyPromptConfig(configPath);
  }
  if (!isRecord(document)) {
    throw new PromptConfigError(`${configPath} must contain a YAML object.`);
  }

  const prompt = document.prompt;
  if (prompt === undefined) {
    return emptyPromptConfig(configPath);
  }
  if (!Array.isArray(prompt)) {
    throw new PromptConfigError(
      `${configPath}: prompt must be a YAML list of changes.`,
    );
  }

  return {
    configPath,
    changes: prompt.map((entry, index) =>
      parseChange(entry, `${configPath}: prompt[${index}]`),
    ),
  };
}

/** Loads prompt configuration from the shared pi-friend YAML file. */
export async function loadPromptConfig(
  options: PromptConfigOptions = {},
): Promise<PromptConfig> {
  const configPath =
    options.configPath ?? getPromptConfigPath(options.agentDir);

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return emptyPromptConfig(configPath);
    }
    throw new PromptConfigError(`Could not read ${configPath}.`, {
      cause: error,
    });
  }

  return parsePromptConfig(source, configPath);
}

/** Returns true when the configuration can change the system prompt. */
export function hasPromptEdits(config: PromptConfig): boolean {
  return config.changes.length > 0;
}

/** Creates the no-op prompt configuration shape. */
function emptyPromptConfig(configPath: string): PromptConfig {
  return {
    configPath,
    changes: [],
  };
}

/** Parses and validates one ordered prompt change. */
function parseChange(value: unknown, location: string): PromptChange {
  if (!isRecord(value)) {
    throw new PromptConfigError(`${location} must be a YAML object.`);
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "section" &&
      key !== "action" &&
      key !== "text" &&
      key !== "files" &&
      key !== "pattern" &&
      key !== "flags"
    ) {
      throw new PromptConfigError(`${location}: unknown field "${key}".`);
    }
  }

  const section = requireNonEmptyString(value.section, `${location}.section`);
  if (
    section !== "preamble" &&
    section !== "addendum" &&
    !isSectionName(section)
  ) {
    throw new PromptConfigError(
      `${location}.section "${section}" is not a valid section name.`,
    );
  }

  const action = parseAction(value.action, `${location}.action`);
  if (value.text !== undefined && typeof value.text !== "string") {
    throw new PromptConfigError(`${location}.text must be a string.`);
  }
  const files = parseFileList(value.files, `${location}.files`);
  if (
    (value.text === undefined || value.text.trim() === "") &&
    files.length === 0
  ) {
    throw new PromptConfigError(
      `${location} requires non-empty text or at least one file.`,
    );
  }

  let pattern: string | undefined;
  if (value.pattern !== undefined) {
    pattern = requireNonEmptyString(value.pattern, `${location}.pattern`);
    if (value.flags !== undefined && typeof value.flags !== "string") {
      throw new PromptConfigError(`${location}.flags must be a string.`);
    }
    try {
      new RegExp(pattern, typeof value.flags === "string" ? value.flags : "g");
    } catch (error) {
      throw new PromptConfigError(`${location}.pattern is not a valid regex.`, {
        cause: error,
      });
    }
  } else if (value.flags !== undefined) {
    throw new PromptConfigError(`${location}.flags requires a pattern.`);
  }

  return {
    section,
    action,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    files,
    ...(pattern === undefined ? {} : { pattern }),
    flags: pattern === undefined ? "" : normalizeFlags(value.flags),
  };
}

/** Parses the required section operation. */
function parseAction(value: unknown, location: string): PromptAction {
  if (value === "replace" || value === "prepend" || value === "append") {
    return value;
  }
  throw new PromptConfigError(
    `${location} must be "replace", "prepend", or "append".`,
  );
}

/** Parses an ordered list of source files. */
function parseFileList(value: unknown, location: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new PromptConfigError(`${location} must be a YAML list.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new PromptConfigError(
        `${location}[${index}] must be a non-empty string.`,
      );
    }
    return entry.trim();
  });
}

/** Applies the default global flag when no explicit flags were supplied. */
function normalizeFlags(value: unknown): string {
  return typeof value === "string" ? value : "g";
}

/** Requires a non-empty string from YAML. */
function requireNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PromptConfigError(`${location} must be a non-empty string.`);
  }
  return value.trim();
}

/** Matches the section names accepted by Pi's system-prompt builder. */
function isSectionName(value: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(value);
}

/** Narrows unknown YAML values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a Node filesystem error code without relying on an any cast. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
