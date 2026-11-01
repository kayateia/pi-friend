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

/** Inline and file-backed text for one system-prompt slot. */
export interface PromptSource {
  text?: string;
  files: string[];
}

/** How replacement text is combined with its target. */
export type PromptReplacementAction = "replace" | "prepend" | "append";

/** One request-time edit to an existing system-prompt section. */
export interface PromptReplacement {
  section: string;
  action: PromptReplacementAction;
  pattern?: string;
  flags: string;
  replacement?: string;
  replacementFile?: string;
}

/** Prompt settings extracted from the shared pi-friend YAML file. */
export interface PromptConfig {
  configPath: string;
  custom?: PromptSource;
  addendum?: PromptSource;
  sections: Record<string, PromptSource>;
  replacements: PromptReplacement[];
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

/** Returns the shared pi-friend configuration path. */
export function getSharedConfigPath(
  agentDir: string = getAgentDir(),
): string {
  return path.join(agentDir, "pi-friend", "pi-friend.yml");
}

/** Parses the `prompt` section while ignoring other extension sections. */
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
  if (!isRecord(prompt)) {
    throw new PromptConfigError(`${configPath}: prompt must be a YAML object.`);
  }
  for (const key of Object.keys(prompt)) {
    if (
      key !== "custom" &&
      key !== "addendum" &&
      key !== "sections" &&
      key !== "replacements"
    ) {
      throw new PromptConfigError(
        `${configPath}: unknown prompt field "${key}".`,
      );
    }
  }

  const custom = parseOptionalSource(
    prompt.custom,
    `${configPath}: prompt.custom`,
  );
  const addendum = parseOptionalSource(
    prompt.addendum,
    `${configPath}: prompt.addendum`,
  );
  const sections = parseSections(prompt.sections, configPath);
  const replacements = parseReplacements(prompt.replacements, configPath);

  return {
    configPath,
    ...(custom === undefined ? {} : { custom }),
    ...(addendum === undefined ? {} : { addendum }),
    sections,
    replacements,
  };
}

/** Loads prompt configuration from the shared pi-friend YAML file. */
export async function loadPromptConfig(
  options: PromptConfigOptions = {},
): Promise<PromptConfig> {
  const configPath =
    options.configPath ?? getSharedConfigPath(options.agentDir);

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
  return (
    config.custom !== undefined ||
    config.addendum !== undefined ||
    Object.keys(config.sections).length > 0 ||
    config.replacements.length > 0
  );
}

/** Creates the no-op prompt configuration shape. */
function emptyPromptConfig(configPath: string): PromptConfig {
  return {
    configPath,
    sections: {},
    replacements: [],
  };
}

/** Parses a scalar or object prompt source. */
function parseOptionalSource(
  value: unknown,
  location: string,
): PromptSource | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? undefined : { text, files: [] };
  }
  if (!isRecord(value)) {
    throw new PromptConfigError(
      `${location} must be a string or an object with text and files.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "text" && key !== "files") {
      throw new PromptConfigError(`${location}: unknown field "${key}".`);
    }
  }

  let text: string | undefined;
  if (value.text !== undefined) {
    if (typeof value.text !== "string") {
      throw new PromptConfigError(`${location}.text must be a string.`);
    }
    text = value.text.trim();
    if (text === "") {
      text = undefined;
    }
  }

  const files = parseFileList(value.files, `${location}.files`);
  if (text === undefined && files.length === 0) {
    return undefined;
  }
  return {
    ...(text === undefined ? {} : { text }),
    files,
  };
}

/** Parses an ordered list of prompt source files. */
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

/** Parses replacements for generated and custom prompt sections. */
function parseSections(
  value: unknown,
  configPath: string,
): Record<string, PromptSource> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new PromptConfigError(
      `${configPath}: prompt.sections must be a YAML object.`,
    );
  }

  const sections: Record<string, PromptSource> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isSectionName(name) || name === "preamble" || name === "addendum") {
      throw new PromptConfigError(
        `${configPath}: invalid prompt.sections name "${name}".`,
      );
    }
    const parsed = parseOptionalSource(
      entry,
      `${configPath}: prompt.sections.${name}`,
    );
    if (parsed !== undefined) {
      sections[name] = parsed;
    }
  }
  return sections;
}

/** Parses ordered prompt replacement rules. */
function parseReplacements(
  value: unknown,
  configPath: string,
): PromptReplacement[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new PromptConfigError(
      `${configPath}: prompt.replacements must be a YAML list.`,
    );
  }

  return value.map((entry, index) =>
    parseReplacement(entry, `${configPath}: prompt.replacements[${index}]`),
  );
}

/** Parses and validates one prompt replacement rule. */
function parseReplacement(value: unknown, location: string): PromptReplacement {
  if (!isRecord(value)) {
    throw new PromptConfigError(`${location} must be a YAML object.`);
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "section" &&
      key !== "action" &&
      key !== "pattern" &&
      key !== "flags" &&
      key !== "replacement" &&
      key !== "replacement_file"
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
    throw new PromptConfigError(
      `${location}.flags requires a pattern.`,
    );
  }

  if (
    value.replacement !== undefined &&
    value.replacement_file !== undefined
  ) {
    throw new PromptConfigError(
      `${location} must use either replacement or replacement_file, not both.`,
    );
  }
  if (value.replacement === undefined && value.replacement_file === undefined) {
    throw new PromptConfigError(
      `${location} requires replacement or replacement_file.`,
    );
  }
  if (value.replacement !== undefined && typeof value.replacement !== "string") {
    throw new PromptConfigError(`${location}.replacement must be a string.`);
  }
  const replacementFile =
    value.replacement_file === undefined
      ? undefined
      : requireNonEmptyString(
          value.replacement_file,
          `${location}.replacement_file`,
        );

  return {
    section,
    action,
    ...(pattern === undefined ? {} : { pattern }),
    flags: pattern === undefined ? "" : normalizeReplacementFlags(value.flags),
    ...(typeof value.replacement === "string"
      ? { replacement: value.replacement }
      : {}),
    ...(replacementFile === undefined ? {} : { replacementFile }),
  };
}

/** Parses the action used to combine replacement text with a section. */
function parseAction(
  value: unknown,
  location: string,
): PromptReplacementAction {
  if (value === undefined) {
    return "replace";
  }
  if (value === "replace" || value === "prepend" || value === "append") {
    return value;
  }
  throw new PromptConfigError(
    `${location} must be "replace", "prepend", or "append".`,
  );
}

/** Applies the default global flag when no explicit flags were supplied. */
function normalizeReplacementFlags(value: unknown): string {
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
