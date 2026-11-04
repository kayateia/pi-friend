/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import {
  watch,
  type FSWatcher,
} from "chokidar";
import type { EmbeddingProvider } from "./embedding.ts";
import {
  buildIndexPathFiles,
  ExternalIndexPathError,
  isImportedVectorEntry,
} from "./external-index.ts";
import { formatErrorChain } from "../debug/log.ts";
import type { IndexedMarkdownFile } from "./indexer.ts";
import {
  compileExcludePatterns,
  isExcludedPath,
  type CompiledExclude,
} from "./index-exclude.ts";
import type { VectorIndex } from "./vector-index.ts";
import { synchronizeVectorIndex } from "./vector-sync.ts";

const DEFAULT_DEBOUNCE_MS = 250;
const WRITE_STABILITY_MS = 200;
const WRITE_POLL_MS = 50;

/** Semantic dependencies used to refresh configured external sources. */
export interface ExternalIndexSemanticDependencies {
  provider: EmbeddingProvider;
  index: VectorIndex;
}

/** Configuration for one session-scoped external source manager. */
export interface ExternalIndexManagerOptions {
  /** Absolute files and directories to index continuously. */
  indexPaths: readonly string[];
  /** Canonical memory root used to preserve normal memory-relative keys. */
  memoryRoot: string;
  /** Resolved `index_exclude` glob patterns. */
  indexExclude?: readonly string[];
  semantic?: ExternalIndexSemanticDependencies;
  /** Embedding chunk size from memory.vector.chunk_size. */
  chunkSize: number;
  /** Reports recoverable scan, watch, and embedding failures. */
  reportWarning: (message: string) => void;
  /** Records full error details for recoverable failures. */
  reportError?: (label: string, error: unknown) => void;
  /** Overrides the change coalescing delay for tests. */
  debounceMs?: number;
  /** Uses polling where native recursive watches are unavailable. */
  usePolling?: boolean;
}

/** Source interface consumed by memory search and semantic synchronization. */
export interface ExternalIndexSource {
  /** Current configured files, refreshed on startup and filesystem changes. */
  getFiles(): readonly IndexedMarkdownFile[];
  /** Waits for any reconciliation already requested by the watcher. */
  refresh(): Promise<void>;
}

/**
 * Maintains the configured external Markdown catalog and its derived vectors.
 *
 * Watcher events are treated as invalidation signals. Each reconciliation
 * rescans the complete configured set so deletes, renames, overlapping paths,
 * and editor save strategies all converge on the same source-of-truth state.
 */
export class ExternalIndexManager implements ExternalIndexSource {
  private readonly indexPaths: string[];
  private readonly memoryRoot: string;
  private readonly excludes: CompiledExclude[];
  private readonly semantic: ExternalIndexSemanticDependencies | undefined;
  private readonly chunkSize: number;
  private readonly reportWarning: (message: string) => void;
  private readonly reportError: (label: string, error: unknown) => void;
  private readonly debounceMs: number;
  private readonly usePolling: boolean;
  private readonly abortController = new AbortController();

  private files: IndexedMarkdownFile[] = [];
  private watcher: FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private reconciliation: Promise<void> | undefined;
  private dirty = false;
  private started = false;
  private stopped = false;

  constructor(options: ExternalIndexManagerOptions) {
    this.indexPaths = [...options.indexPaths];
    this.memoryRoot = options.memoryRoot;
    this.excludes = compileExcludePatterns(options.indexExclude ?? []);
    this.semantic = options.semantic;
    this.chunkSize = options.chunkSize;
    this.reportWarning = options.reportWarning;
    this.reportError = options.reportError ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.usePolling = options.usePolling ?? false;
  }

  /** Returns the most recently reconciled configured source files. */
  getFiles(): readonly IndexedMarkdownFile[] {
    return this.files;
  }

  /**
   * Starts watching before the initial scan and reconciles configured sources.
   *
   * Starting the watcher first ensures changes made during the scan mark the
   * manager dirty and receive a follow-up pass.
   */
  async start(): Promise<void> {
    if (this.started) {
      await this.refresh();
      return;
    }
    this.started = true;
    this.stopped = false;
    this.startWatcher();
    await this.rescan();
  }

  /**
   * Waits for any pending watcher-triggered reconciliation to finish.
   *
   * This lets searches observe changes without forcing another complete scan
   * when no filesystem invalidation is pending.
   */
  async refresh(): Promise<void> {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
      await this.rescan();
      return;
    }
    await this.reconciliation;
  }

  /** Explicitly rescans every configured path and updates the vector index. */
  async rescan(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.dirty = true;
    if (this.reconciliation === undefined) {
      const running = this.drainReconciliations();
      this.reconciliation = running;
      try {
        await running;
      } finally {
        if (this.reconciliation === running) {
          this.reconciliation = undefined;
        }
      }
      return;
    }
    await this.reconciliation;
  }

  /**
   * Stops watcher input, aborts pending embedding work, and waits for cleanup.
   *
   * The operation is idempotent because Pi can converge multiple shutdown paths
   * onto the same extension instance.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.close();
    this.abortController.abort();
    await this.reconciliation;
  }

  /** Processes all invalidations accumulated while a reconciliation is active. */
  private async drainReconciliations(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      try {
        await this.reconcile();
      } catch (error) {
        if (this.abortController.signal.aborted) {
          return;
        }
        this.reportError("external index scan", error);
        this.reportWarning(
          `pi-friend external index scan failed: ${formatErrorChain(error)}`,
        );
      }
    }
  }

  /** Rebuilds the complete external catalog and updates its scoped vectors. */
  private async reconcile(): Promise<void> {
    const filesByPath = new Map<string, IndexedMarkdownFile>();
    for (const configuredPath of this.indexPaths) {
      if (this.abortController.signal.aborted) {
        return;
      }

      try {
        const prepared = await buildIndexPathFiles(configuredPath, {
          cwd: path.dirname(configuredPath),
          memoryRoot: this.memoryRoot,
          allowEmpty: true,
          exclude: this.excludes,
        });
        for (const file of prepared.files) {
          filesByPath.set(file.absolutePath, file);
        }
      } catch (error) {
        if (!(error instanceof ExternalIndexPathError)) {
          throw error;
        }
        this.reportError("external index path", error);
        this.reportWarning(
          `pi-friend external index path unavailable: ${formatErrorChain(error)}`,
        );
      }
    }

    this.files = [...filesByPath.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    await this.synchronizeVectors();
  }

  /** Synchronizes changed external vectors and removes stale imported records. */
  private async synchronizeVectors(): Promise<void> {
    if (this.semantic === undefined || this.abortController.signal.aborted) {
      return;
    }

    try {
      await synchronizeVectorIndex(
        this.files,
        this.semantic.provider,
        this.semantic.index,
        {
          prune: isImportedVectorEntry,
          chunkSize: this.chunkSize,
          signal: this.abortController.signal,
        },
      );
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }
      this.reportError("external index refresh", error);
      this.reportWarning(
        `pi-friend external index refresh failed: ${formatErrorChain(error)}`,
      );
    }
  }

  /** Starts one recursive watcher covering every configured source path. */
  private startWatcher(): void {
    if (this.indexPaths.length === 0 || this.stopped) {
      return;
    }

    try {
      this.watcher = watch(this.indexPaths, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        usePolling: this.usePolling,
        atomic: true,
        awaitWriteFinish: {
          stabilityThreshold: WRITE_STABILITY_MS,
          pollInterval: WRITE_POLL_MS,
        },
        ignored: (candidate) => this.isIgnored(candidate),
      });
      this.watcher.on("all", () => this.scheduleReconcile());
      this.watcher.on("error", (error) => {
        this.reportError("external index watcher", error);
        this.reportWarning(
          `pi-friend external index watcher failed: ${formatErrorChain(error)}`,
        );
      });
    } catch (error) {
      this.watcher = undefined;
      this.reportError("external index watcher initialization", error);
      this.reportWarning(
        `pi-friend external index watcher unavailable: ${formatErrorChain(error)}`,
      );
    }
  }

  /** Coalesces editor and rename event bursts into one source rescan. */
  private scheduleReconcile(): void {
    if (this.stopped) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.rescan();
    }, this.debounceMs);
  }

  /**
   * Ignores paths the importer would never read anyway.
   *
   * Two reasons: dot paths below a configured root (while still watching a
   * dot-named root itself), and the store's own paths or anything matched by
   * `index_exclude`. Without the second part, a watch over a parent of the
   * memory store would treat every memory write as a source change and rescan
   * forever.
   */
  private isIgnored(candidate: string): boolean {
    if (isExcludedPath(candidate, this.memoryRoot, this.excludes)) {
      return true;
    }
    return this.isHiddenWithinConfiguredPath(candidate);
  }

  /**
   * Ignores dot paths below configured roots while still watching a dot-named
   * root itself and its non-hidden descendants.
   */
  private isHiddenWithinConfiguredPath(candidate: string): boolean {
    const absolute = path.resolve(candidate);
    for (const root of this.indexPaths) {
      const relative = path.relative(root, absolute);
      if (relative === "") {
        return false;
      }
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        continue;
      }
      return relative
        .split(path.sep)
        .some((segment) => segment.startsWith("."));
    }
    return false;
  }
}
