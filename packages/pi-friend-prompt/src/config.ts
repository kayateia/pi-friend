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

/** Prompt settings extracted from the shared pi-friend YAML file. */
export interface PromptConfig {
  configPath: string;
  customPrompt?: string;
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
    return { configPath };
  }
  if (!isRecord(document)) {
    throw new PromptConfigError(`${configPath} must contain a YAML object.`);
  }

  const prompt = document.prompt;
  if (prompt === undefined) {
    return { configPath };
  }
  if (!isRecord(prompt)) {
    throw new PromptConfigError(`${configPath}: prompt must be a YAML object.`);
  }
  for (const key of Object.keys(prompt)) {
    if (key !== "custom") {
      throw new PromptConfigError(
        `${configPath}: unknown prompt field "${key}".`,
      );
    }
  }
  if (prompt.custom === undefined) {
    return { configPath };
  }
  if (typeof prompt.custom !== "string") {
    throw new PromptConfigError(
      `${configPath}: prompt.custom must be a string.`,
    );
  }

  const customPrompt = prompt.custom.trim();
  return {
    configPath,
    ...(customPrompt === "" ? {} : { customPrompt }),
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
      return { configPath };
    }
    throw new PromptConfigError(`Could not read ${configPath}.`, {
      cause: error,
    });
  }

  return parsePromptConfig(source, configPath);
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
