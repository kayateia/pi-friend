/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

/** Resolved memory configuration used by the storage layer. */
export interface MemoryConfig {
  /** Absolute path to the user's pi-friend.yml file. */
  configPath: string;
  /** Absolute path to the canonical memory tree. */
  root: string;
}

/** Inputs that can be overridden by tests or alternate Pi environments. */
export interface MemoryConfigOptions {
  /** Pi agent directory containing the pi-friend config directory. */
  agentDir?: string;
  /** Home directory used for leading-tilde expansion. */
  homeDir?: string;
}

/** Error raised when the configuration file exists but cannot be used safely. */
export class MemoryConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryConfigError";
  }
}

/**
 * Returns the directory holding pi-friend configuration and its default tree.
 */
export function getFriendConfigDir(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, "pi-friend");
}

/**
 * Resolves a leading "~" without interpreting arbitrary shell expressions.
 */
export function expandHomePath(value: string, home: string): string {
  if (value === "~") {
    return home;
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }

  return value;
}

/**
 * Parses the pi-friend configuration source using the supplied path context.
 *
 * An absent or empty file uses defaults. A present config with an invalid
 * shape raises an error so the extension never writes to an unintended tree.
 */
export function parseMemoryConfig(
  source: string,
  configPath: string,
  homeDir: string = homedir(),
): MemoryConfig {
  const configDir = path.dirname(configPath);
  const defaultRoot = path.join(configDir, "memory");

  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new MemoryConfigError(`Could not parse ${configPath}.`, {
      cause: error,
    });
  }

  if (document === null || document === undefined) {
    return { configPath, root: defaultRoot };
  }

  if (!isRecord(document)) {
    throw new MemoryConfigError(`${configPath} must contain a YAML object.`);
  }

  const memory = document.memory;
  if (memory === undefined) {
    return { configPath, root: defaultRoot };
  }

  if (!isRecord(memory)) {
    throw new MemoryConfigError(`${configPath}: memory must be a YAML object.`);
  }

  const configuredRoot = memory.root;
  if (configuredRoot === undefined) {
    return { configPath, root: defaultRoot };
  }

  if (typeof configuredRoot !== "string" || configuredRoot.trim() === "") {
    throw new MemoryConfigError(`${configPath}: memory.root must be a non-empty string.`);
  }

  const expandedRoot = expandHomePath(configuredRoot.trim(), homeDir);
  const root = path.isAbsolute(expandedRoot)
    ? path.normalize(expandedRoot)
    : path.resolve(configDir, expandedRoot);

  return { configPath, root };
}

/**
 * Loads the user's configuration, falling back to defaults only when the file
 * or memory.root field is absent.
 */
export async function loadMemoryConfig(
  options: MemoryConfigOptions = {},
): Promise<MemoryConfig> {
  const agentDir = options.agentDir ?? getAgentDir();
  const homeDir = options.homeDir ?? homedir();
  const configDir = getFriendConfigDir(agentDir);
  const configPath = path.join(configDir, "pi-friend.yml");

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {
        configPath,
        root: path.join(configDir, "memory"),
      };
    }

    throw new MemoryConfigError(`Could not read ${configPath}.`, {
      cause: error,
    });
  }

  return parseMemoryConfig(source, configPath, homeDir);
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
