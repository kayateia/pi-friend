/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  MemoryConfig,
  MemoryConfigOptions,
} from "./config.ts";
import { loadMemoryConfig } from "./config.ts";
import { ensureMemoryLayout } from "./layout.ts";
import type {
  MemoryFileKind,
  MemoryPaths,
} from "./paths.ts";
import {
  assertNoSymlinkSegments,
  classifyMemoryMarkdown,
  createMemoryPaths,
  MemoryPathError,
  relativeKey,
  resolveWithin,
  validateSlug,
} from "./paths.ts";

const RECOVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable description of a discoverable Markdown file. */
export interface StoredMarkdownFile {
  absolutePath: string;
  /** POSIX-style path relative to the memory root. */
  relativePath: string;
  kind: MemoryFileKind;
}

/** One append-only access-log record. */
export interface AccessLogEntry {
  /** Defaults to the current UTC ISO timestamp. */
  timestamp?: string;
  source: "rag" | "tool";
  slug?: string;
  path?: string;
  tier?: string;
  query?: string;
}

/** Error raised when a storage request violates the store contract. */
export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

/**
 * Filesystem-backed storage for one resolved memory tree.
 *
 * This layer handles paths and exact text I/O only. Front-matter parsing and
 * node validation belong to the schema layer.
 */
export class MemoryStore {
  readonly config: MemoryConfig;
  readonly paths: MemoryPaths;
  readonly root: string;

  /** Creates a store after loading config, initializing layout, and resolving root. */
  static async open(options: MemoryConfigOptions = {}): Promise<MemoryStore> {
    const config = await loadMemoryConfig(options);
    const paths = createMemoryPaths(config.root, config.configPath);
    await ensureMemoryLayout(paths);
    const root = await realpath(paths.root);
    return new MemoryStore(config, paths, root);
  }

  private constructor(
    config: MemoryConfig,
    paths: MemoryPaths,
    root: string,
  ) {
    this.config = config;
    this.paths = paths;
    this.root = root;
  }

  /** Reads exact Markdown text without normalization. */
  async readTextFile(relativePath: string): Promise<string> {
    const target = await this.resolveMemoryPath(relativePath);
    return readFile(target, "utf8");
  }

  /** Reads a Markdown file, returning null only when it does not exist. */
  async readTextFileIfExists(relativePath: string): Promise<string | null> {
    try {
      return await this.readTextFile(relativePath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  /**
   * Atomically replaces a Markdown file while preserving exact content.
   *
   * Daily logs and the access log deliberately reject this operation because
   * their integrity depends on append-only behavior.
   */
  async writeTextFile(relativePath: string, content: string): Promise<void> {
    if (!relativePath.endsWith(".md")) {
      throw new MemoryStoreError("Memory text files must use the .md extension.");
    }

    await this.replaceFile(relativePath, content);
  }

  /** Reads one recovery record as raw JSON text, or null when it is absent. */
  async readRecoveryRecord(recoveryId: string): Promise<string | null> {
    return this.readTextFileIfExists(recoveryRelativePath(recoveryId));
  }

  /** Atomically writes one validated recovery record. */
  async writeRecoveryRecord(
    recoveryId: string,
    content: string,
  ): Promise<void> {
    await this.replaceFile(recoveryRelativePath(recoveryId), content);
  }

  /** Reads a canonical node by validated slug. */
  async readNodeText(slug: string): Promise<string> {
    return this.readTextFile(nodeRelativePath(slug));
  }

  /** Atomically writes a canonical node by validated slug. */
  async writeNodeText(slug: string, content: string): Promise<void> {
    await this.writeTextFile(nodeRelativePath(slug), content);
  }

  /** Removes one Markdown file that is not protected as append-only. */
  async removeTextFile(relativePath: string): Promise<void> {
    const target = resolveWithin(this.root, relativePath);
    this.assertWritableTarget(target);

    await withFileMutationQueue(target, async () => {
      await assertNoSymlinkSegments(this.root, target);
      await unlink(target);
    });
  }

  /** Exact text returned by the validator for a canonical node slug. */
  nodeRelativePath(slug: string): string {
    return nodeRelativePath(validateSlug(slug));
  }

  /** Appends exact text to a validated local-calendar daily log. */
  async appendDaily(date: string, content: string): Promise<void> {
    if (!isValidDailyDate(date)) {
      throw new MemoryStoreError(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
    }

    await this.appendText(`daily/${date}.md`, content);
  }

  /** Appends one JSON line to the access log. */
  async appendAccessLog(entry: AccessLogEntry): Promise<void> {
    const timestamp = entry.timestamp ?? new Date().toISOString();
    const record: AccessLogEntry = {
      ...entry,
      timestamp,
    };
    await this.appendText("access-log", `${JSON.stringify(record)}\n`);
  }

  /** Lists all searchable Markdown files without reading their contents. */
  async listMarkdownFiles(): Promise<StoredMarkdownFile[]> {
    const files: StoredMarkdownFile[] = [];
    await this.collectMarkdownFiles("", files);
    return files.sort((left, right) => {
      if (left.relativePath < right.relativePath) {
        return -1;
      }
      if (left.relativePath > right.relativePath) {
        return 1;
      }
      return 0;
    });
  }

  /** Appends text to an internal append-only file. */
  private async appendText(relativePath: string, content: string): Promise<void> {
    const target = await this.resolveMemoryPath(relativePath);

    await withFileMutationQueue(target, async () => {
      await assertNoSymlinkSegments(this.root, target);
      const handle = await open(target, "a", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /** Serializes and atomically replaces any internal file. */
  private async replaceFile(
    relativePath: string,
    content: string,
  ): Promise<void> {
    const target = resolveWithin(this.root, relativePath);
    this.assertWritableTarget(target);

    await withFileMutationQueue(target, async () => {
      await assertNoSymlinkSegments(this.root, target);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await assertNoSymlinkSegments(this.root, target);
      await writeFileAtomically(target, content);
    });
  }

  /** Resolves a path and rejects symlinks in any existing segment. */
  private async resolveMemoryPath(relativePath: string): Promise<string> {
    const target = resolveWithin(this.root, relativePath);
    await assertNoSymlinkSegments(this.root, target);
    return target;
  }

  /** Rejects replacement of files whose integrity depends on append-only writes. */
  private assertWritableTarget(target: string): void {
    const key = relativeKey(this.root, target);
    if (key === "access-log" || key.startsWith("daily/")) {
      throw new MemoryStoreError(
        `${key} is append-only and cannot be replaced.`,
      );
    }
  }

  /** Recursively collects Markdown documents, skipping index state and symlinks. */
  private async collectMarkdownFiles(
    relativeDirectory: string,
    files: StoredMarkdownFile[],
  ): Promise<void> {
    const absoluteDirectory =
      relativeDirectory === ""
        ? this.root
        : resolveWithin(this.root, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
        continue;
      }

      if (relativeDirectory === "" && entry.name === "index") {
        continue;
      }

      const relativePath =
        relativeDirectory === ""
          ? entry.name
          : path.join(relativeDirectory, entry.name);

      if (entry.isDirectory()) {
        await this.collectMarkdownFiles(relativePath, files);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const posixPath = relativePath.split(path.sep).join("/");
      files.push({
        absolutePath: resolveWithin(this.root, relativePath),
        relativePath: posixPath,
        kind: classifyMemoryMarkdown(posixPath),
      });
    }
  }
}

/** Builds the canonical node-relative path after slug validation. */
function nodeRelativePath(slug: string): string {
  return `nodes/${validateSlug(slug)}.md`;
}

/** Builds and validates a recovery record filename. */
function recoveryRelativePath(recoveryId: string): string {
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
    throw new MemoryStoreError("Recovery ID must be a valid UUID.");
  }
  return `recovery/${recoveryId}.json`;
}

/** Validates a real YYYY-MM-DD local-calendar date. */
export function isValidDailyDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** Writes a same-directory temporary file, syncs it, then renames it. */
async function writeFileAtomically(
  target: string,
  content: string,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, target);
  } finally {
    if (handle) {
      await handle.close();
    }
    await rm(temporaryPath, { force: true });
  }
}

/** Returns a Node filesystem error code without relying on an any cast. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
