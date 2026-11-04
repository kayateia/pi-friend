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
import {
  DEFAULT_CHUNK_SIZE,
  MAX_CONFIG_CHUNK_SIZE,
  MIN_CONFIG_CHUNK_SIZE,
} from "./chunker.ts";
import { DEFAULT_EMBEDDING_MODEL } from "./embedding.ts";
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

/** Configuration for periodic conversation capture into staging. */
export interface AutoCaptureConfig {
  enabled: boolean;
  everyTurns: number;
  /** Seconds of post-settlement idle time before capture runs. */
  idleTimeout: number;
  maxCandidates: number;
  /** Optional provider/model-id override for the capture model. */
  model?: string;
  /** Optional replacement for the capture model's system prompt. */
  prompt?: string;
  /** Optional text appended after the built-in capture system prompt. */
  promptAppend?: string;
}

/** Configuration for the daily consolidation pass. */
export interface SweepConfig {
  enabled: boolean;
  /** Run post-turn consolidation without holding up agent settlement. */
  background: boolean;
  /** Optional provider/model-id override for candidate decisions. */
  model?: string;
  /** Optional replacement for the sweep model's system prompt. */
  prompt?: string;
  /** Optional text appended after the built-in sweep system prompt. */
  promptAppend?: string;
  /**
   * Offer the sweep model a `drop` action, which archives a candidate under
   * `sweeps/dropped/` instead of promoting or merging it. Off by default: the
   * upstream design deliberately has no drop, and this is the disagreement made
   * configurable rather than the default changed on someone else's behalf.
   */
  allowDrop: boolean;
  tombstoneGraceDays: number;
  /** Batches smaller than this bypass the 25% removal guard. */
  minGuardedBatchSize: number;
}

/** Configuration for the post-sweep dream narrative pass. */
export interface DreamingConfig {
  enabled: boolean;
  maxNodes: number;
  /** Optional provider/model-id override for dream selection and writing. */
  model?: string;
  /** Optional replacement for the dream model's system prompt. */
  prompt?: string;
  /** Optional text appended after the built-in dream system prompt. */
  promptAppend?: string;
}

/** Configuration for the derived vector index. */
export interface VectorConfig {
  /** Maximum characters supplied for one embedding chunk. */
  chunkSize: number;
}

/** Configuration for the semantic embedding provider. */
export interface EmbeddingsConfig {
  /** Provider-qualified model identifier, such as openrouter/<model-id>. */
  model: string;
}

/** Default prefix for model-facing memory tool names. */
export const DEFAULT_MEMORY_TOOL_PREFIX = "";

/** Filename used for the memory extension's configuration. */
export const MEMORY_CONFIG_FILENAME = "pi-friend-memory.yml";

/** Resolved memory configuration used by the storage layer. */
export interface MemoryConfig {
  /** Absolute path to the user's pi-friend-memory.yml file. */
  configPath: string;
  /** Prefix prepended to every registered memory tool name. */
  toolPrefix: string;
  /** Absolute path to the canonical memory tree. */
  root: string;
  /** Resolved files and directory trees watched and included in search. */
  indexPaths: string[];
  /**
   * Resolved glob patterns whose matches are never imported from `indexPaths`.
   * The memory root is always excluded, whether or not it appears here.
   */
  indexExclude: string[];
  injection: RagInjectionConfig;
  autoCapture: AutoCaptureConfig;
  sweep: SweepConfig;
  dreaming: DreamingConfig;
  vector: VectorConfig;
  embeddings: EmbeddingsConfig;
  /**
   * Non-fatal configuration problems found while loading, such as unknown
   * fields or prompt text that names vocabulary the code cannot honour.
   * Reported once at startup; never treated as errors.
   */
  warnings: string[];
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

/** Returns the default staged-capture policy. */
export function defaultAutoCaptureConfig(): AutoCaptureConfig {
  return {
    enabled: true,
    everyTurns: 5,
    idleTimeout: 600,
    maxCandidates: 3,
  };
}

/** Returns the default daily-sweep policy. */
export function defaultSweepConfig(): SweepConfig {
  return {
    enabled: true,
    background: false,
    tombstoneGraceDays: 30,
    minGuardedBatchSize: 10,
    allowDrop: false,
  };
}

/** Returns the default dreaming policy. */
export function defaultDreamingConfig(): DreamingConfig {
  return {
    enabled: true,
    maxNodes: 4,
  };
}

/** Returns the default derived-index policy. */
export function defaultVectorConfig(): VectorConfig {
  return {
    chunkSize: DEFAULT_CHUNK_SIZE,
  };
}

/** Returns the default semantic embedding policy. */
export function defaultEmbeddingsConfig(): EmbeddingsConfig {
  return {
    model: `openrouter/${DEFAULT_EMBEDDING_MODEL}`,
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
      toolPrefix: DEFAULT_MEMORY_TOOL_PREFIX,
      root: defaultRoot,
      indexPaths: [],
      indexExclude: [],
      injection: defaultRagInjectionConfig(),
      autoCapture: defaultAutoCaptureConfig(),
      sweep: defaultSweepConfig(),
      dreaming: defaultDreamingConfig(),
      vector: defaultVectorConfig(),
      embeddings: defaultEmbeddingsConfig(),
      warnings: [],
    };
  }

  if (!isRecord(document)) {
    throw new MemoryConfigError(`${configPath} must contain a YAML object.`);
  }
  const warnings: string[] = [];
  collectUnknownKeys(document, "document", configPath, warnings);

  const memory = document.memory;
  if (memory !== undefined && !isRecord(memory)) {
    throw new MemoryConfigError(`${configPath}: memory must be a YAML object.`);
  }
  const memoryConfig = memory ?? {};
  collectUnknownKeys(memoryConfig, "memory",
    `${configPath}: memory`,
    warnings,
  );

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
    toolPrefix: parseToolPrefix(memoryConfig.tool_prefix, configPath),
    root,
    indexPaths: parseIndexPaths(
      memoryConfig.index_paths,
      configPath,
      configDir,
      homeDir,
    ),
    indexExclude: parseIndexExclude(
      memoryConfig.index_exclude,
      configPath,
      configDir,
      homeDir,
    ),
    injection: parseRagInjection(memoryConfig.injection, configPath, warnings),
    autoCapture: parseAutoCapture(
      memoryConfig.auto_capture,
      configPath,
      warnings,
    ),
    sweep: parseSweep(memoryConfig.sweep, configPath, warnings),
    dreaming: parseDreaming(memoryConfig.dreaming, configPath, warnings),
    vector: parseVector(memoryConfig.vector, configPath, warnings),
    embeddings: parseEmbeddings(memoryConfig.embeddings, configPath, warnings),
    warnings,
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
  const configPath = path.join(configDir, MEMORY_CONFIG_FILENAME);

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {
        configPath,
        toolPrefix: DEFAULT_MEMORY_TOOL_PREFIX,
        root: path.join(configDir, "memory"),
        indexPaths: [],
        indexExclude: [],
        injection: defaultRagInjectionConfig(),
        autoCapture: defaultAutoCaptureConfig(),
        sweep: defaultSweepConfig(),
        dreaming: defaultDreamingConfig(),
        vector: defaultVectorConfig(),
        embeddings: defaultEmbeddingsConfig(),
        warnings: [],
      };
    }

    throw new MemoryConfigError(`Could not read ${configPath}.`, {
      cause: error,
    });
  }

  return parseMemoryConfig(source, configPath, homeDir);
}

/** Parses a safe lowercase prefix that is prepended to memory tool names. */
function parseToolPrefix(value: unknown, configPath: string): string {
  if (value === undefined) {
    return DEFAULT_MEMORY_TOOL_PREFIX;
  }
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    (value !== "" && !/^[a-z][a-z0-9_]*$/u.test(value))
  ) {
    throw new MemoryConfigError(
      `${configPath}: memory.tool_prefix must be empty or start with a lowercase letter and contain only lowercase letters, digits, and underscores (maximum 32 characters).`,
    );
  }
  return value;
}

/**
 * Parses the external Markdown paths watched by the memory index.
 *
 * Paths are resolved exactly once at configuration load so every watcher and
 * reconciliation uses the same identity. Relative paths are anchored to the
 * directory containing pi-friend-memory.yml, matching memory.root.
 */
function parseIndexPaths(
  value: unknown,
  configPath: string,
  configDir: string,
  homeDir: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.index_paths must be a YAML array of path strings.`,
    );
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new MemoryConfigError(
        `${configPath}: memory.index_paths[${index}] must be a non-empty string.`,
      );
    }

    const expanded = expandHomePath(item.trim(), homeDir);
    const absolute = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(configDir, expanded);
    if (!seen.has(absolute)) {
      seen.add(absolute);
      resolved.push(absolute);
    }
  }
  return resolved;
}

/**
 * Parses `index_exclude`, resolving `~` and relative patterns like `index_paths`.
 *
 * Glob characters survive resolution untouched, so a recursive draft pattern
 * keeps its meaning while still anchoring to the configuration directory.
 */
function parseIndexExclude(
  value: unknown,
  configPath: string,
  configDir: string,
  homeDir: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.index_exclude must be a YAML array of path patterns.`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new MemoryConfigError(
        `${configPath}: memory.index_exclude[${index}] must be a non-empty string.`,
      );
    }
    const expanded = expandHomePath(entry.trim(), homeDir);
    return path.resolve(configDir, expanded);
  });
}

/** Parses optional vector-index settings while applying safe defaults. */
function parseVector(
  value: unknown,
  configPath: string,
  warnings: string[],
): VectorConfig {
  const config = defaultVectorConfig();
  if (value === undefined) {
    return config;
  }
  if (!isRecord(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.vector must be a YAML object.`,
    );
  }
  collectUnknownKeys(value, "vector",
    `${configPath}: memory.vector`,
    warnings,
  );
  if (value.chunk_size !== undefined) {
    if (
      typeof value.chunk_size !== "number" ||
      !Number.isInteger(value.chunk_size) ||
      value.chunk_size < MIN_CONFIG_CHUNK_SIZE ||
      value.chunk_size > MAX_CONFIG_CHUNK_SIZE
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.vector.chunk_size must be an integer from ${MIN_CONFIG_CHUNK_SIZE} to ${MAX_CONFIG_CHUNK_SIZE}.`,
      );
    }
    config.chunkSize = value.chunk_size;
  }
  return config;
}

/** Parses optional injection settings while applying safe defaults. */
function parseRagInjection(
  value: unknown,
  configPath: string,
  warnings: string[],
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
  collectUnknownKeys(value, "injection",
    `${configPath}: memory.injection`,
    warnings,
  );

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

/** Parses optional auto-capture settings while applying safe defaults. */
function parseAutoCapture(
  value: unknown,
  configPath: string,
  warnings: string[],
): AutoCaptureConfig {
  const config = defaultAutoCaptureConfig();
  if (value === undefined) {
    return config;
  }
  if (!isRecord(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.auto_capture must be a YAML object.`,
    );
  }
  collectUnknownKeys(value, "auto_capture",
    `${configPath}: memory.auto_capture`,
    warnings,
  );

  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new MemoryConfigError(
        `${configPath}: memory.auto_capture.enabled must be a boolean.`,
      );
    }
    config.enabled = value.enabled;
  }
  if (value.every_turns !== undefined) {
    if (
      typeof value.every_turns !== "number" ||
      !Number.isInteger(value.every_turns) ||
      value.every_turns < 1 ||
      value.every_turns > 100
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.auto_capture.every_turns must be an integer from 1 to 100.`,
      );
    }
    config.everyTurns = value.every_turns;
  }
  if (value.idle_timeout !== undefined) {
    if (
      typeof value.idle_timeout !== "number" ||
      !Number.isInteger(value.idle_timeout) ||
      value.idle_timeout < 1 ||
      value.idle_timeout > 86_400
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.auto_capture.idle_timeout must be an integer number of seconds from 1 to 86400.`,
      );
    }
    config.idleTimeout = value.idle_timeout;
  }
  if (value.max_candidates !== undefined) {
    if (
      typeof value.max_candidates !== "number" ||
      !Number.isInteger(value.max_candidates) ||
      value.max_candidates < 1 ||
      value.max_candidates > 20
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.auto_capture.max_candidates must be an integer from 1 to 20.`,
      );
    }
    config.maxCandidates = value.max_candidates;
  }
  if (value.model !== undefined) {
    if (
      typeof value.model !== "string" ||
      value.model.trim() === "" ||
      !value.model.includes("/") ||
      value.model.trim().startsWith("/") ||
      value.model.trim().endsWith("/")
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.auto_capture.model must be a non-empty provider/model-id string.`,
      );
    }
    config.model = value.model.trim();
  }
  applyModelPrompt(
    config,
    value,
    configPath,
    "memory.auto_capture",
    "capture",
    warnings,
  );
  return config;
}

/** Parses optional daily-sweep settings. */
function parseSweep(
  value: unknown,
  configPath: string,
  warnings: string[],
): SweepConfig {
  const config = defaultSweepConfig();
  if (value === undefined) {
    return config;
  }
  if (!isRecord(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.sweep must be a YAML object.`,
    );
  }
  collectUnknownKeys(value, "sweep",
    `${configPath}: memory.sweep`,
    warnings,
  );
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new MemoryConfigError(
        `${configPath}: memory.sweep.enabled must be a boolean.`,
      );
    }
    config.enabled = value.enabled;
  }
  if (value.background !== undefined) {
    if (typeof value.background !== "boolean") {
      throw new MemoryConfigError(
        `${configPath}: memory.sweep.background must be a boolean.`,
      );
    }
    config.background = value.background;
  }
  if (value.model !== undefined) {
    if (
      typeof value.model !== "string" ||
      !value.model.includes("/") ||
      value.model.trim().startsWith("/") ||
      value.model.trim().endsWith("/")
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.sweep.model must be a provider/model-id string.`,
      );
    }
    config.model = value.model.trim();
  }
  if (value.allow_drop !== undefined) {
    if (typeof value.allow_drop !== "boolean") {
      throw new MemoryConfigError(
        `${configPath}: memory.sweep.allow_drop must be a boolean.`,
      );
    }
    config.allowDrop = value.allow_drop;
  }
  applyModelPrompt(
    config,
    value,
    configPath,
    "memory.sweep",
    "sweep",
    warnings,
    { allowDrop: config.allowDrop },
  );
  // A replacement prompt owns the vocabulary, so enabling drop and replacing the
  // prompt without mentioning it is a silent no-op worth naming.
  if (
    config.allowDrop &&
    config.prompt !== undefined &&
    !/\bdrop\b/iu.test(config.prompt)
  ) {
    warnings.push(
      `${configPath}: memory.sweep.allow_drop is enabled but memory.sweep.prompt never mentions drop, so the model will never choose it.`,
    );
  }
  if (value.tombstone_grace_days !== undefined) {
    if (
      typeof value.tombstone_grace_days !== "number" ||
      !Number.isInteger(value.tombstone_grace_days) ||
      value.tombstone_grace_days < 1 ||
      value.tombstone_grace_days > 3650
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.sweep.tombstone_grace_days must be an integer from 1 to 3650.`,
      );
    }
    config.tombstoneGraceDays = value.tombstone_grace_days;
  }
  if (value.min_guarded_batch_size !== undefined) {
    if (
      typeof value.min_guarded_batch_size !== "number" ||
      !Number.isInteger(value.min_guarded_batch_size) ||
      value.min_guarded_batch_size < 1 ||
      value.min_guarded_batch_size > 10_000
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.sweep.min_guarded_batch_size must be an integer from 1 to 10000.`,
      );
    }
    config.minGuardedBatchSize = value.min_guarded_batch_size;
  }
  return config;
}

/** Parses optional dreaming settings. */
function parseDreaming(
  value: unknown,
  configPath: string,
  warnings: string[],
): DreamingConfig {
  const config = defaultDreamingConfig();
  if (value === undefined) {
    return config;
  }
  if (!isRecord(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.dreaming must be a YAML object.`,
    );
  }
  collectUnknownKeys(value, "dreaming",
    `${configPath}: memory.dreaming`,
    warnings,
  );
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new MemoryConfigError(
        `${configPath}: memory.dreaming.enabled must be a boolean.`,
      );
    }
    config.enabled = value.enabled;
  }
  if (value.max_nodes !== undefined) {
    if (
      typeof value.max_nodes !== "number" ||
      !Number.isInteger(value.max_nodes) ||
      value.max_nodes < 2 ||
      value.max_nodes > 10
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.dreaming.max_nodes must be an integer from 2 to 10.`,
      );
    }
    config.maxNodes = value.max_nodes;
  }
  if (value.model !== undefined) {
    if (
      typeof value.model !== "string" ||
      !value.model.includes("/") ||
      value.model.trim().startsWith("/") ||
      value.model.trim().endsWith("/")
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.dreaming.model must be a provider/model-id string.`,
      );
    }
    config.model = value.model.trim();
  }
  applyModelPrompt(
    config,
    value,
    configPath,
    "memory.dreaming",
    "dream",
    warnings,
  );
  return config;
}

/** Parses a non-empty replacement prompt for an internal model request. */
function parseModelPrompt(
  value: unknown,
  configPath: string,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new MemoryConfigError(
      `${configPath}: ${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

/** Parses the optional semantic embedding configuration. */
function parseEmbeddings(
  value: unknown,
  configPath: string,
  warnings: string[],
): EmbeddingsConfig {
  const config = defaultEmbeddingsConfig();
  if (value === undefined) {
    return config;
  }
  if (!isRecord(value)) {
    throw new MemoryConfigError(
      `${configPath}: memory.embeddings must be a YAML object.`,
    );
  }
  collectUnknownKeys(value, "embeddings",
    `${configPath}: memory.embeddings`,
    warnings,
  );
  if (value.model !== undefined) {
    if (
      typeof value.model !== "string" ||
      value.model.trim() === "" ||
      !value.model.includes("/") ||
      value.model.trim().startsWith("/") ||
      value.model.trim().endsWith("/")
    ) {
      throw new MemoryConfigError(
        `${configPath}: memory.embeddings.model must be a provider/model-id string.`,
      );
    }
    config.model = value.model.trim();
  }
  return config;
}

/** Sections whose system prompt can be replaced or extended by config. */
type PromptSection = "capture" | "sweep" | "dream";

/**
 * Reads `prompt` and `prompt_append` for one internal model section.
 *
 * The two are mutually exclusive: replacing a prompt is supported, but it is
 * never combined with appending, because the result would depend on an implicit
 * precedence rule nobody can see in the file.
 */
function applyModelPrompt(
  config: { prompt?: string; promptAppend?: string },
  value: Record<string, unknown>,
  configPath: string,
  field: string,
  section: PromptSection,
  warnings: string[],
  options: { allowDrop?: boolean } = {},
): void {
  const prompt = parseModelPrompt(value.prompt, configPath, `${field}.prompt`);
  const promptAppend = parseModelPrompt(
    value.prompt_append,
    configPath,
    `${field}.prompt_append`,
  );
  if (prompt !== undefined && promptAppend !== undefined) {
    throw new MemoryConfigError(
      `${configPath}: ${field}.prompt and ${field}.prompt_append cannot both be set; prompt replaces the built-in prompt and prompt_append extends it.`,
    );
  }
  if (prompt !== undefined) {
    config.prompt = prompt;
    collectPromptWarnings(
      prompt,
      section,
      `${configPath}: ${field}.prompt`,
      warnings,
      options,
    );
  }
  if (promptAppend !== undefined) {
    config.promptAppend = promptAppend;
    collectPromptWarnings(
      promptAppend,
      section,
      `${configPath}: ${field}.prompt_append`,
      warnings,
      options,
    );
  }
}

/** Configuration objects and the fields this version actually reads. */
const KNOWN_KEYS = {
  document: ["memory"],
  memory: [
    "root",
    "tool_prefix",
    "index_paths",
    "index_exclude",
    "vector",
    "injection",
    "auto_capture",
    "sweep",
    "dreaming",
    "embeddings",
  ],
  injection: ["enabled", "position", "mode", "limit", "max_chars"],
  vector: ["chunk_size"],
  auto_capture: [
    "enabled",
    "every_turns",
    "idle_timeout",
    "max_candidates",
    "model",
    "prompt",
    "prompt_append",
  ],
  sweep: [
    "enabled",
    "background",
    "model",
    "prompt",
    "prompt_append",
    "allow_drop",
    "tombstone_grace_days",
    "min_guarded_batch_size",
  ],
  dreaming: ["enabled", "max_nodes", "model", "prompt", "prompt_append"],
  embeddings: ["model"],
} as const;

/**
 * Fields that used to configure a feature which no longer exists.
 *
 * These earn a specific sentence instead of "unknown field", because the reader
 * is usually looking at a configuration that predates the removal and needs to
 * know that nothing replaces it.
 */
const REMOVED_KEYS: Record<string, Record<string, string>> = {
  injection: {
    daily:
      "the daily-log injection feature was removed, so this section does nothing; recalled memory nodes are injected instead",
  },
};

/**
 * Reports fields this version does not read.
 *
 * Unknown keys are ignored rather than rejected, so a misnamed or removed
 * option used to disable a whole feature in silence: `promptAddition` looks
 * exactly like a working key until nothing happens.
 */
function collectUnknownKeys(
  value: Record<string, unknown>,
  section: keyof typeof KNOWN_KEYS,
  location: string,
  warnings: string[],
): void {
  const knownKeys: readonly string[] = KNOWN_KEYS[section];
  for (const key of Object.keys(value)) {
    if (knownKeys.includes(key)) {
      continue;
    }
    const removed = REMOVED_KEYS[section]?.[key];
    warnings.push(
      removed === undefined
        ? `${location}: unknown field "${key}" was ignored.`
        : `${location}.${key} is no longer read: ${removed}.`,
    );
  }
}

/**
 * True when the text instructs capture to label a speaker as `unknown`.
 *
 * `unknown` is one of the generic names the parser rejects, so this instruction
 * deletes the candidates it was meant to keep — the failure is silent, which is
 * why it earns a warning. Merely mentioning the word is not enough.
 */
function assignsUnknownSpeaker(text: string): boolean {
  return /(?:use|record|label|attribute|write|set)\b[^.\n]{0,40}\bunknown\b/iu.test(
    text,
  );
}

/** Words that look like sweep actions but are not part of the vocabulary. */
const SWEEP_ACTION_NEAR_MISSES = [
  "drop",
  "discard",
  "defer",
  "skip",
  "archive",
  "reject",
];

/**
 * Reports custom prompt text that appears to name vocabulary the code cannot
 * honour.
 *
 * This is deliberately narrow, not an attempt to understand prose: it looks for
 * sweep actions outside the enum and for the one speaker instruction that
 * silently costs candidates, and says what the code will do with them. Ordinary
 * words that happen to resemble vocabulary ("the inner life of a person", a
 * quoted mention of `USER`) are left alone, because a warning that cries wolf
 * teaches people to ignore warnings. It never blocks startup and never inspects
 * the built-in prompts.
 */
function collectPromptWarnings(
  text: string,
  section: PromptSection,
  location: string,
  warnings: string[],
  options: { allowDrop?: boolean } = {},
): void {
  const mentions = (word: string): boolean =>
    new RegExp(`\\b${word}\\b`, "iu").test(text);

  if (section === "sweep") {
    for (const word of SWEEP_ACTION_NEAR_MISSES) {
      if (word === "drop" && options.allowDrop === true) {
        continue;
      }
      if (mentions(word)) {
        warnings.push(
          `${location} mentions "${word}", which is not a sweep action; the parser accepts only promote and merge and silently ignores anything else.`,
        );
      }
    }
  }

  if (section === "capture" && assignsUnknownSpeaker(text)) {
    warnings.push(
      `${location} tells capture to attribute a speaker as "unknown"; the parser treats that as a generic name and discards those candidates, so name the speaker or omit the candidate instead.`,
    );
  }
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
