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
import type { MemorySearchMode } from "./search.ts";

/** Configuration for automatic memory retrieval and prompt injection. */
export interface RagInjectionConfig {
  enabled: boolean;
  /** 0 for the current user turn, -1 for one prompt back, and so on. */
  position: number;
  mode: MemorySearchMode;
  limit: number;
  maxChars: number;
}

/** Resolved memory configuration used by the storage layer. */
export interface MemoryConfig {
  /** Absolute path to the user's pi-friend.yml file. */
  configPath: string;
  /** Absolute path to the canonical memory tree. */
  root: string;
  injection: RagInjectionConfig;
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

/** Returns the default retrieval/injection policy. */
export function defaultRagInjectionConfig(): RagInjectionConfig {
  return {
    enabled: true,
    position: -1,
    mode: "hybrid",
    limit: 5,
    maxChars: 6_000,
  };
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
    return {
      configPath,
      root: defaultRoot,
      injection: defaultRagInjectionConfig(),
    };
  }

  if (!isRecord(document)) {
    throw new MemoryConfigError(`${configPath} must contain a YAML object.`);
  }

  const memory = document.memory;
  if (memory !== undefined && !isRecord(memory)) {
    throw new MemoryConfigError(`${configPath}: memory must be a YAML object.`);
  }
  const memoryConfig = memory ?? {};

  const configuredRoot = memoryConfig.root;
  let root = defaultRoot;
  if (configuredRoot !== undefined) {
    if (typeof configuredRoot !== "string" || configuredRoot.trim() === "") {
      throw new MemoryConfigError(`${configPath}: memory.root must be a non-empty string.`);
    }

    const expandedRoot = expandHomePath(configuredRoot.trim(), homeDir);
    root = path.isAbsolute(expandedRoot)
      ? path.normalize(expandedRoot)
      : path.resolve(configDir, expandedRoot);
  }

  return {
    configPath,
    root,
    injection: parseRagInjection(memoryConfig.injection, configPath),
  };
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
        injection: defaultRagInjectionConfig(),
      };
    }

    throw new MemoryConfigError(`Could not read ${configPath}.`, {
      cause: error,
    });
  }

  return parseMemoryConfig(source, configPath, homeDir);
}

/** Parses optional injection settings while applying safe defaults. */
function parseRagInjection(
  value: unknown,
  configPath: string,
): RagInjectionConfig {
  const config = defaultRagInjectionConfig();
  if (value === undefined) {
    return config;
  }
  if (!isRecord(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.injection must be a YAML object.`,
    );
  }

  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new MemoryConfigError(
        `${configPath}: memory.injection.enabled must be a boolean.`,
      );
    }
    config.enabled = value.enabled;
  }

  if (value.position !== undefined) {
    if (
      typeof value.position !== "number" ||
      !Number.isInteger(value.position) ||
      value.position > 0
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.injection.position must be zero or a negative integer.`,
      );
    }
    config.position = value.position;
  }

  if (value.mode !== undefined) {
    if (!isSearchMode(value.mode)) {
      throw new MemoryConfigError(
        `${configPath}: memory.injection.mode must be keyword, semantic, or hybrid.`,
      );
    }
    config.mode = value.mode;
  }

  if (value.limit !== undefined) {
    if (
      typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 25
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.injection.limit must be an integer from 1 to 25.`,
      );
    }
    config.limit = value.limit;
  }

  if (value.max_chars !== undefined) {
    if (
      typeof value.max_chars !== "number" ||
      !Number.isInteger(value.max_chars) ||
      value.max_chars < 200 ||
      value.max_chars > 50_000
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.injection.max_chars must be an integer from 200 to 50000.`,
      );
    }
    config.maxChars = value.max_chars;
  }

  return config;
}

/** Narrows an unknown config value to a supported search mode. */
function isSearchMode(value: unknown): value is MemorySearchMode {
  return value === "keyword" || value === "semantic" || value === "hybrid";
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
