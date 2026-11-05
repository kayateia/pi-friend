/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorChain, logError } from "../debug/log.ts";
import type { MemorySpeaker, MemoryType, ParsedMemoryNode } from "./schema.ts";
import {
  isQuarantinedMemoryType,
  parseMemoryNode,
  serializeMemoryNode,
} from "./schema.ts";
import { validateSlug } from "./paths.ts";
import { appendAuditEntry } from "./audit.ts";
import type { HistoryKind } from "./history.ts";
import {
  VERSIONED_HISTORY_KINDS,
  historyEntryPath,
  listHistoryVersions,
  pruneHistorySlug,
  readHistoryEntry,
  stripHistoryFields,
  versionTimestamp,
  writeHistoryEntry,
} from "./history.ts";

/**
 * Process-wide mutation queues keyed by the resolved memory root.
 *
 * pi-web-ui loads a separate extension runtime for each conversation. An
 * instance-local queue prevents races only within one conversation; multiple
 * conversations can still allocate the same slug or interleave sweep writes.
 * Sharing the queue by canonical root preserves operation-level ordering across
 * all memory services in this process.
 */
const mutationQueues = new Map<string, Promise<void>>();
import { buildMemoryDocumentIndex } from "./indexer.ts";
import type { IndexedMarkdownFile } from "./indexer.ts";
import { searchHybrid } from "./hybrid-search.ts";
import type { EmbeddingProvider } from "./embedding.ts";
import type { MemorySearchOptions, MemorySearchResult } from "./search.ts";
import { kindsForCorpus, searchIndexedFiles } from "./search.ts";
import { searchSemantically } from "./semantic-search.ts";
import type { VectorIndex } from "./vector-index.ts";
import { buildEmbeddingText } from "./vector-sync.ts";
import { synchronizeVectorIndex } from "./vector-sync.ts";
import { searchSemanticVectors } from "./semantic-search.ts";
import type { ExternalIndexSource } from "./external-index-manager.ts";
import { computeDecayUpdates, type DecayUpdate } from "./decay.ts";
import type { MemoryNodeArea, MemoryNodeRepository } from "./repository.ts";

/** Input accepted when creating a new canonical memory node. */
export interface MemoryAddInput {
  title: string;
  type: MemoryType;
  body: string;
  speaker: MemorySpeaker[];
  slug?: string;
  agents?: string[];
  emotionalFlavor?: string;
  tags?: string[];
  links?: string[];
  source?: string;
}

/** Editable fields on an existing canonical memory node. */
export interface MemoryEditInput {
  title?: string;
  type?: MemoryType;
  body?: string;
  speaker?: MemorySpeaker[];
  agents?: string[];
  emotionalFlavor?: string;
  tags?: string[];
  links?: string[];
  source?: string;
  reason?: string;
}

/** Result of moving one canonical node into the history tree. */
export interface MemoryDeletionResult {
  slug: string;
  /** Path of the archived copy, relative to the memory root. */
  historyPath: string;
  original: ParsedMemoryNode;
}

/** Result of copying one memory back out of the history tree. */
export interface MemoryRestorationResult {
  slug: string;
  node: ParsedMemoryNode;
  /** True when an existing canonical node was replaced and archived. */
  replaced: boolean;
  /** Whatever the restored entry recorded as having been restored. */
  restoredFrom: string;
  /** Children removed because the restored entry was a split source. */
  removedChildren: string[];
  /** Children that were recorded by the split but no longer exist. */
  missingChildren: string[];
}

/** Result of staging one auto-captured candidate. */
export interface MemoryStageResult {
  node: ParsedMemoryNode;
  created: boolean;
}

/** Result of promoting one staging candidate. */
export interface MemoryPromotionResult {
  node: ParsedMemoryNode;
  merged: boolean;
  mergedInto?: string;
}

/** Input for creating one post-sweep dream node. */
export interface MemoryDreamInput {
  title: string;
  narrative: string;
  nodeSlugs: string[];
  agents?: string[];
  source?: string;
}

/** Optional semantic-search dependencies, available only when configured. */
export interface SemanticSearchDependencies {
  provider: EmbeddingProvider;
  index: VectorIndex;
}

/** Error raised when a memory operation cannot preserve its invariants. */
export class MemoryServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryServiceError";
  }
}

/**
 * Application-level memory operations shared by Pi tools and tests.
 *
 * Adds are serialized so slug allocation and collision checks cannot race
 * within one extension runtime.
 */
export class MemoryNodeService {
  private readonly repository: MemoryNodeRepository;
  private readonly now: () => Date;
  private readonly semantic: SemanticSearchDependencies | undefined;
  private readonly externalIndex: ExternalIndexSource | undefined;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(
    repository: MemoryNodeRepository,
    now: () => Date = () => new Date(),
    semantic: SemanticSearchDependencies | undefined = undefined,
    externalIndex: ExternalIndexSource | undefined = undefined,
  ) {
    this.repository = repository;
    this.now = now;
    this.semantic = semantic;
    this.externalIndex = externalIndex;
  }

  /** Storage handle used by sweep artifact/state management. */
  get store() {
    return this.repository.store;
  }

  /** True when semantic and hybrid search can run in this runtime. */
  get canSearchSemantically(): boolean {
    return this.semantic !== undefined;
  }

  /** Lists staging candidates for sweep decisions. */
  async listStagingCandidates(): Promise<ParsedMemoryNode[]> {
    return this.repository.list("staging");
  }

  /** Lists canonical nodes for sweep decisions and decay. */
  async listCanonicalNodes(): Promise<ParsedMemoryNode[]> {
    return this.repository.list("canonical");
  }

  /**
   * Runs a multi-step operation while blocking other state-changing service
   * calls. Nested service calls made by the operation are re-entrant.
   */
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.runSerialized(() => this.lockContext.run(true, operation));
  }

  /** Creates a dream node linked to its canonical source memories. */
  async createDream(input: MemoryDreamInput): Promise<ParsedMemoryNode> {
    return this.runSerialized(async () => {
      const slugs = [...new Set(input.nodeSlugs)];
      if (slugs.length < 2) {
        throw new MemoryServiceError(
          "A dream requires at least two source nodes.",
        );
      }
      const sources: ParsedMemoryNode[] = [];
      for (const slug of slugs) {
        const node = await this.repository.read(slug, "canonical");
        if (
          node === null ||
          node.frontMatter.status !== "active" ||
          isQuarantinedMemoryType(node.frontMatter.type)
        ) {
          throw new MemoryServiceError(
            `Dream source "${slug}" is not an active canonical memory.`,
          );
        }
        sources.push(node);
      }

      const narrative = input.narrative.trim();
      if (narrative === "") {
        throw new MemoryServiceError("Dream narrative must not be empty.");
      }
      const dreamSlug = await this.allocateSlug({
        title: input.title,
        type: "dream",
        body: narrative,
        speaker: [],
      });
      const timestamp = this.now().toISOString();
      const sourceLines = sources.map(
        (node) => `- ${node.frontMatter.title} (nodes/${node.slug}.md)`,
      );
      const seeAlso = sources.map((node) => {
        const keywords =
          node.frontMatter.tags.slice(0, 5).join(", ") ||
          node.frontMatter.emotional_flavor ||
          "memory";
        return `- ${node.frontMatter.title} — ${keywords}`;
      });
      const body = [
        narrative,
        "Dream synthesized from:",
        ...sourceLines,
        "",
        "see also:",
        ...seeAlso,
      ].join("\n");

      const dream: ParsedMemoryNode = {
        slug: dreamSlug,
        body: `\n${body}\n`,
        frontMatter: {
          title: input.title.trim(),
          type: "dream",
          speaker: [
            {
              name: "pi-friend",
              confident: false,
              note: "synthesized dream",
            },
          ],
          agents: input.agents ?? [],
          created: timestamp,
          last_used: timestamp,
          use_count: 0,
          decay_weight: 1,
          status: "active",
          emotional_flavor: "dreamlike",
          tags: ["dream"],
          supersedes: [],
          superseded_by: "",
          links: slugs,
          source: input.source ?? `dream; sources: ${slugs.join(", ")}`,
        },
      };
      await this.repository.write(dream, "canonical");
      return dream;
    });
  }

  /** Reads a node from one lifecycle area. */
  async read(
    slug: string,
    area: MemoryNodeArea = "canonical",
  ): Promise<ParsedMemoryNode | null> {
    return this.repository.read(slug, area);
  }

  /** Searches all indexed Markdown files and records returned tool hits. */
  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    if (options.query.trim() === "") {
      throw new MemoryServiceError("Search query must not be empty.");
    }
    if (options.corpus !== undefined && options.kinds !== undefined) {
      throw new MemoryServiceError(
        "Search options cannot set both corpus and kinds.",
      );
    }
    const resolved: MemorySearchOptions =
      options.corpus === undefined
        ? options
        : { ...options, kinds: kindsForCorpus(options.corpus) };

    const index = await this.buildSearchIndex();
    const mode = options.mode ?? this.store.config.search.defaultMode;
    const vectorOptions = {
      chunkSize: this.store.config.vector.chunkSize,
    };
    let results: MemorySearchResult[];
    if (mode === "semantic" || mode === "hybrid") {
      if (!this.semantic) {
        throw new MemoryServiceError(
          "Semantic and hybrid search are unavailable because no embedding provider is configured.",
        );
      }
      results =
        mode === "hybrid"
          ? await searchHybrid(
              index,
              resolved,
              this.semantic.provider,
              this.semantic.index,
              vectorOptions,
            )
          : await searchSemantically(
              index,
              resolved,
              this.semantic.provider,
              this.semantic.index,
              vectorOptions,
            );
    } else {
      results = searchIndexedFiles(index, resolved);
    }

    for (const result of results) {
      await this.repository.store.appendAccessLog({
        source: "tool",
        ...(result.slug === undefined ? {} : { slug: result.slug }),
        path: result.relativePath,
        tier: mode,
        query: options.query,
      });
    }

    return results;
  }

  /** Recomputes volume-relative decay metadata for canonical nodes. */
  async recomputeDecay(): Promise<DecayUpdate[]> {
    return this.runSerialized(async () => {
      const nodes = await this.repository.list("canonical");
      const accessLog =
        (await this.repository.store.readTextFileIfExists("access-log")) ?? "";
      const updates = computeDecayUpdates(nodes, accessLog, {
        reportError: (label, error) => logError(label, error),
      });
      const bySlug = new Map(nodes.map((node) => [node.slug, node]));

      for (const update of updates) {
        const node = bySlug.get(update.slug);
        if (!node) continue;
        node.frontMatter.use_count = update.useCount;
        node.frontMatter.last_used = update.lastUsed;
        node.frontMatter.decay_weight = update.decayWeight;
        await this.repository.write(node, "canonical");
      }

      return updates;
    });
  }

  /** Writes planned staging decay metadata before sweep decisions are applied. */
  async applyCandidateDecay(updates: DecayUpdate[]): Promise<void> {
    return this.runSerialized(async () => {
      for (const update of updates) {
        const candidate = await this.repository.read(update.slug, "staging");
        if (candidate === null) {
          continue;
        }
        candidate.frontMatter.use_count = update.useCount;
        candidate.frontMatter.last_used = update.lastUsed;
        candidate.frontMatter.decay_weight = update.decayWeight;
        await this.repository.write(candidate, "staging");
      }
    });
  }

  /** Creates one canonical active node with schema-compliant defaults. */
  async add(input: MemoryAddInput): Promise<ParsedMemoryNode> {
    return this.runSerialized(async () => {
      const slug = await this.allocateSlug(input);
      const body = input.body.trim();
      if (body === "") {
        throw new MemoryServiceError("Memory body must not be empty.");
      }

      const timestamp = this.now().toISOString();
      const node: ParsedMemoryNode = {
        slug,
        body: `\n${body}\n`,
        frontMatter: {
          title: input.title.trim(),
          type: input.type,
          speaker: input.speaker,
          agents: input.agents ?? [],
          created: timestamp,
          last_used: timestamp,
          use_count: 0,
          decay_weight: 1,
          status: "active",
          emotional_flavor: input.emotionalFlavor ?? "neutral",
          tags: input.tags ?? [],
          supersedes: [],
          superseded_by: "",
          links: input.links ?? [],
          source: input.source ?? "",
        },
      };

      await this.repository.write(node);
      return node;
    });
  }

  /** Stages one candidate after exact canonical/staging deduplication. */
  async stageCandidate(input: MemoryAddInput): Promise<MemoryStageResult> {
    return this.runSerialized(async () => {
      const signature = memorySignature(input.title, input.body);
      for (const area of ["canonical", "staging"] as const) {
        const existing = (await this.repository.list(area)).find(
          (node) =>
            memorySignature(node.frontMatter.title, node.body) === signature,
        );
        if (existing) {
          return { node: existing, created: false };
        }
      }

      const slug = await this.allocateSlug(input);
      const body = input.body.trim();
      if (body === "") {
        throw new MemoryServiceError("Memory body must not be empty.");
      }

      const timestamp = this.now().toISOString();
      const node: ParsedMemoryNode = {
        slug,
        body: `\n${body}\n`,
        frontMatter: {
          title: input.title.trim(),
          type: input.type,
          speaker: input.speaker,
          agents: input.agents ?? [],
          created: timestamp,
          last_used: timestamp,
          use_count: 0,
          decay_weight: 1,
          status: "candidate",
          emotional_flavor: input.emotionalFlavor ?? "neutral",
          tags: input.tags ?? [],
          supersedes: [],
          superseded_by: "",
          links: input.links ?? [],
          source: input.source ?? "",
        },
      };

      await this.repository.write(node, "staging");
      return { node, created: true };
    });
  }

  /**
   * Promotes one staging candidate, merging into a semantically near-duplicate
   * canonical node when one is found.
   */
  async promoteCandidate(
    slug: string,
    preferredTarget?: string,
    options: { conflict?: string } = {},
  ): Promise<MemoryPromotionResult> {
    return this.runSerialized(async () => {
      const candidate = await this.repository.read(slug, "staging");
      if (candidate === null) {
        throw new MemoryServiceError(
          `No staging candidate found for "${slug}".`,
        );
      }

      const now = this.now().toISOString();
      let target = preferredTarget
        ? await this.repository.read(preferredTarget, "canonical")
        : await this.repository.read(candidate.slug, "canonical");
      if (preferredTarget && target === null) {
        throw new MemoryServiceError(
          `Preferred merge target "${preferredTarget}" does not exist.`,
        );
      }
      if (target !== null && isQuarantinedMemoryType(target.frontMatter.type)) {
        throw new MemoryServiceError(
          `Cannot merge a staging candidate into ${target.frontMatter.type} memory "${target.slug}".`,
        );
      }
      if (target === null && this.semantic) {
        target = await this.findPromotionDuplicate(candidate);
      }

      if (target !== null) {
        // Both sides are stored before the write. A merge is the one operation
        // whose inputs stop existing afterwards: the target is rewritten in
        // place and the candidate leaves staging.
        const conflict = options.conflict?.trim();
        await writeHistoryEntry(this.repository.store, {
          kind: "merged",
          slug: target.slug,
          timestamp: now,
          node: {
            slug: target.slug,
            frontMatter: {
              ...target.frontMatter,
              ...(conflict === undefined || conflict === ""
                ? {}
                : { history_conflict: conflict }),
            },
            body: target.body,
          },
        });
        await writeHistoryEntry(this.repository.store, {
          kind: "merged",
          slug: candidate.slug,
          timestamp: now,
          node: cloneNode(candidate),
        });
        await this.pruneHistoryFor("merged", target.slug);
        await this.pruneHistoryFor("merged", candidate.slug);

        const merged = mergeCandidate(target, candidate, now);
        await this.repository.write(merged, "canonical");
        await this.repository.remove(candidate.slug, "staging");
        return {
          node: merged,
          merged: true,
          mergedInto: target.slug,
        };
      }

      const promoted = cloneNode(candidate);
      promoted.frontMatter.status = "active";
      promoted.frontMatter.decay_weight = 1;
      promoted.frontMatter.last_used = now;
      promoted.frontMatter.edited = now;
      promoted.frontMatter.superseded_by = "";
      promoted.body = appendAuditEntry(
        promoted.body,
        now,
        "memory_promote: promoted from staging",
      );

      await this.repository.write(promoted, "canonical");
      await this.repository.remove(candidate.slug, "staging");
      return { node: promoted, merged: false };
    });
  }

  /** Archives one dropped staging candidate under the sweep artifacts. */
  async archiveCandidate(slug: string, sweepId: string): Promise<string> {
    return this.runSerialized(async () => {
      const candidate = await this.repository.read(slug, "staging");
      if (candidate === null) {
        throw new MemoryServiceError(
          `No staging candidate found for "${slug}".`,
        );
      }
      const path = `sweeps/dropped/${sweepId}/${slug}.md`;
      await this.repository.store.writeTextFile(
        path,
        serializeMemoryNode(candidate),
      );
      await this.repository.remove(slug, "staging");
      return path;
    });
  }

  /** Updates editable node fields while preserving creation and usage state. */
  async edit(slug: string, input: MemoryEditInput): Promise<ParsedMemoryNode> {
    return this.runSerialized(async () => {
      const node = await this.repository.read(slug);
      if (node === null) {
        throw new MemoryServiceError(
          `No canonical memory found for "${slug}".`,
        );
      }

      const hasEdit = [
        input.title,
        input.type,
        input.body,
        input.speaker,
        input.agents,
        input.emotionalFlavor,
        input.tags,
        input.links,
        input.source,
      ].some((value) => value !== undefined);
      if (!hasEdit) {
        throw new MemoryServiceError("No memory fields were supplied to edit.");
      }

      const timestamp = this.now().toISOString();
      const frontMatter = {
        ...node.frontMatter,
        speaker: node.frontMatter.speaker.map((speaker) => ({ ...speaker })),
        agents: [...node.frontMatter.agents],
        tags: [...node.frontMatter.tags],
        supersedes: [...node.frontMatter.supersedes],
        links: [...node.frontMatter.links],
      };

      if (input.title !== undefined) frontMatter.title = input.title;
      if (input.type !== undefined) frontMatter.type = input.type;
      if (input.speaker !== undefined) frontMatter.speaker = input.speaker;
      if (input.agents !== undefined) frontMatter.agents = input.agents;
      if (input.emotionalFlavor !== undefined) {
        frontMatter.emotional_flavor = input.emotionalFlavor;
      }
      if (input.tags !== undefined) frontMatter.tags = input.tags;
      if (input.links !== undefined) frontMatter.links = input.links;
      if (input.source !== undefined) frontMatter.source = input.source;
      frontMatter.edited = timestamp;

      let body = node.body;
      if (input.body !== undefined) {
        const updatedBody = input.body.trim();
        if (updatedBody === "") {
          throw new MemoryServiceError("Memory body must not be empty.");
        }
        body = `\n${updatedBody}\n`;
      }
      const updated: ParsedMemoryNode = {
        slug: node.slug,
        frontMatter,
        body,
      };

      // The version being replaced is the only copy that exists until this
      // write lands, so it is stored first. The reason describes the edit that
      // ends it, which is why it belongs to the history file rather than to the
      // node: the node is not changed by having been changed.
      await writeHistoryEntry(this.repository.store, {
        kind: "edited",
        slug: node.slug,
        timestamp,
        node: {
          slug: node.slug,
          frontMatter: {
            ...node.frontMatter,
            ...(input.reason === undefined || input.reason.trim() === ""
              ? {}
              : { history_reason: input.reason.trim() }),
          },
          body: node.body,
        },
      });
      await this.pruneHistoryFor("edited", node.slug);

      await this.repository.write(updated);
      return updated;
    });
  }

  /**
   * Moves exactly one matching canonical node into the history tree.
   *
   * The archived copy is written before the canonical file is removed, and it
   * is the node exactly as it was, so restoring is a copy rather than a
   * reconstruction. Ambiguous substring matches are rejected so a broad request
   * cannot delete several memories by accident.
   */
  async delete(match: string): Promise<MemoryDeletionResult> {
    return this.runSerialized(async () => {
      const query = match.trim();
      if (query === "") {
        throw new MemoryServiceError("Delete match must not be empty.");
      }

      const nodes = await this.repository.list("canonical");
      const exact = nodes.find((node) => node.slug === query.toLowerCase());
      let target = exact;
      if (!target) {
        const normalizedQuery = query.toLowerCase();
        const matches = nodes.filter((node) =>
          [
            node.slug,
            node.frontMatter.title,
            node.frontMatter.tags.join(" "),
            node.body,
          ]
            .join("\n")
            .toLowerCase()
            .includes(normalizedQuery),
        );

        if (matches.length === 0) {
          throw new MemoryServiceError(
            `No canonical memory matches "${query}".`,
          );
        }
        if (matches.length > 1) {
          throw new MemoryServiceError(
            `"${query}" matches multiple memories: ${matches
              .map((node) => node.slug)
              .join(", ")}. Use an exact slug or a narrower match.`,
          );
        }
        target = matches[0];
      }

      const original = cloneNode(target);
      const historyPath = await writeHistoryEntry(this.repository.store, {
        kind: "deleted",
        slug: target.slug,
        node: cloneNode(target),
      });
      try {
        await this.repository.remove(target.slug, "canonical");
      } catch (error) {
        // The node is still canonical, so the archive would claim a deletion
        // that did not happen. Drop it and let the failure stand.
        await this.repository.store.removeTextFile(historyPath).catch(() => {});
        throw error;
      }

      return { slug: target.slug, historyPath, original };
    });
  }

  /**
   * Restores a deleted memory from its history entry.
   *
   * Restoring is a copy with the edits a live node needs: the archived file is
   * the node as it was, so only the `edited` timestamp is stamped, the history
   * fields are stripped, and the entry is removed because the memory is no
   * longer deleted. A newer canonical node with the same slug wins — restoring
   * must not overwrite work done since.
   */
  async restore(
    slug: string,
    timestamp?: string,
  ): Promise<MemoryRestorationResult> {
    return this.runSerialized(async () => {
      const validSlug = validateSlug(slug);
      const now = this.now().toISOString();

      // A deleted entry is the default target: it is the one history entry a
      // memory has after it leaves nodes/. A named timestamp selects a version
      // instead, and without one the newest version across the versioned kinds
      // wins, which is what "put it back how it was" means in practice.
      const relativePath =
        timestamp === undefined
          ? ((await this.findDeletedEntry(validSlug)) ??
            (await this.findNewestVersion(validSlug)))
          : await this.findVersion(validSlug, timestamp);
      if (relativePath === null) {
        throw new MemoryServiceError(
          timestamp === undefined
            ? `No deleted memory or stored version named "${validSlug}" is in history.`
            : `No stored version of "${validSlug}" from ${timestamp} is in history.`,
        );
      }

      const archived = await readHistoryEntry(
        this.repository.store,
        relativePath,
        validSlug,
      );
      if (archived === null) {
        throw new MemoryServiceError(
          `History entry ${relativePath} disappeared while restoring.`,
        );
      }

      const removedChildren: string[] = [];
      const missingChildren: string[] = [];
      for (const child of archived.frontMatter.history_children ?? []) {
        if ((await this.repository.read(child)) === null) {
          missingChildren.push(child);
          continue;
        }
        await this.repository.remove(child, "canonical");
        removedChildren.push(child);
      }

      // A live node with the same slug is replaced on purpose: restoring a
      // different memory over a reused name is the case this exists for. Its
      // text is archived first, because restoring is deliberate but should not
      // be the one operation that loses content without a copy.
      const current = await this.repository.read(validSlug);
      if (current !== null) {
        await writeHistoryEntry(this.repository.store, {
          kind: "edited",
          slug: validSlug,
          timestamp: now,
          node: {
            slug: validSlug,
            frontMatter: {
              ...current.frontMatter,
              history_reason: "replaced by memory_restore",
            },
            body: current.body,
          },
        });
      }

      const restored = cloneNode(archived);
      restored.frontMatter = stripHistoryFields(restored.frontMatter);
      restored.frontMatter.status = "active";
      restored.frontMatter.decay_weight = 1;
      restored.frontMatter.last_used = now;
      restored.frontMatter.edited = now;

      await this.repository.write(restored, "canonical");
      await this.repository.store.removeTextFile(relativePath);
      return {
        slug: validSlug,
        node: restored,
        replaced: current !== null,
        restoredFrom: relativePath,
        removedChildren,
        missingChildren,
      };
    });
  }

  /** Returns the slug's deleted entry path when one exists. */
  private async findDeletedEntry(slug: string): Promise<string | null> {
    const relativePath = historyEntryPath("deleted", slug);
    const text = await this.repository.store.readTextFileIfExists(relativePath);
    return text === null ? null : relativePath;
  }

  /** Returns the newest stored version across the versioned kinds. */
  private async findNewestVersion(slug: string): Promise<string | null> {
    let newest: string | null = null;
    for (const kind of VERSIONED_HISTORY_KINDS) {
      const versions = await listHistoryVersions(
        this.repository.store,
        kind,
        slug,
      );
      for (const version of versions) {
        if (newest === null || versionTimestamp(version) > versionTimestamp(newest)) {
          newest = version;
        }
      }
    }
    return newest;
  }

  /** Returns one stored version by timestamp, across the versioned kinds. */
  private async findVersion(
    slug: string,
    timestamp: string,
  ): Promise<string | null> {
    for (const kind of VERSIONED_HISTORY_KINDS) {
      const relativePath = historyEntryPath(kind, slug, timestamp);
      const text = await this.repository.store.readTextFileIfExists(relativePath);
      if (text !== null) {
        return relativePath;
      }
    }
    return null;
  }

  /** Serializes state-changing operations, except when already inside a lock. */
  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore() === true) {
      return operation();
    }

    const queueKey = this.repository.store.root;
    const previous = mutationQueues.get(queueKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutationQueues.set(queueKey, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (mutationQueues.get(queueKey) === next) {
        mutationQueues.delete(queueKey);
      }
    }
  }

  /** Chooses an explicit slug or derives a unique slug from the title. */
  private async allocateSlug(input: MemoryAddInput): Promise<string> {
    const requested = input.slug?.trim();
    if (requested) {
      const slug = validateSlug(requested);
      if (await this.slugExists(slug)) {
        throw new MemoryServiceError(
          `A memory named "${slug}" already exists.`,
        );
      }
      return slug;
    }

    const base = slugifyTitle(input.title);
    if (!(await this.slugExists(base))) {
      return base;
    }

    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const ending = `-${suffix}`;
      const prefix = base.slice(0, 120 - ending.length).replace(/-+$/g, "");
      const candidate = `${prefix}${ending}`;
      if (!(await this.slugExists(candidate))) {
        return candidate;
      }
    }

    throw new MemoryServiceError(
      `Could not allocate a slug for "${input.title}".`,
    );
  }

  /**
   * Applies retention to one slug after a version is written.
   *
   * Per-slug rather than whole-tree: an edit should not pay for the size of
   * `history/`, and the sweep's daily pass catches anything this misses.
   */
  private async pruneHistoryFor(kind: HistoryKind, slug: string): Promise<void> {
    await pruneHistorySlug(this.repository.store, kind, slug).catch(
      (error: unknown) => logError("history retention", error),
    );
  }

  /**
   * Checks the live areas for a slug.
   *
   * History is deliberately not consulted: a slug that exists only in history
   * is available for a new memory, and restoring an older one over it is an
   * intentional overwrite rather than a collision to prevent. That is what
   * makes "delete this, write it again, restore the old one" work.
   */
  private async slugExists(slug: string): Promise<boolean> {
    for (const area of ["canonical", "staging"] satisfies MemoryNodeArea[]) {
      if ((await this.repository.read(slug, area)) !== null) {
        return true;
      }
    }
    return false;
  }

  /** Finds the closest canonical node above the promotion similarity threshold. */
  private async findPromotionDuplicate(
    candidate: ParsedMemoryNode,
  ): Promise<ParsedMemoryNode | null> {
    if (!this.semantic) {
      return null;
    }

    const files = await this.buildSearchIndex();
    await synchronizeVectorIndex(
      files,
      this.semantic.provider,
      this.semantic.index,
      { chunkSize: this.store.config.vector.chunkSize },
    );
    const candidateFile = files.find(
      (file) => file.relativePath === `staging/${candidate.slug}.md`,
    );
    if (!candidateFile) {
      return null;
    }

    const [embedding] = await this.semantic.provider.embed([
      buildEmbeddingText(candidateFile),
    ]);
    if (!embedding) {
      return null;
    }

    const results = searchSemanticVectors(
      files,
      embedding,
      {
        query: candidate.frontMatter.title,
        mode: "semantic",
        limit: 10,
      },
      this.semantic.index,
      this.store.config.vector.chunkSize,
    );
    const duplicate = results.find(
      (result) =>
        result.kind === "node" &&
        result.status === "active" &&
        result.type !== undefined &&
        !isQuarantinedMemoryType(result.type) &&
        result.slug !== undefined &&
        result.slug !== candidate.slug &&
        result.score >= 0.92,
    );
    return duplicate?.slug
      ? this.repository.read(duplicate.slug, "canonical")
      : null;
  }

  /** Builds the in-memory search corpus from memory files and imports. */
  private async buildSearchIndex(): Promise<IndexedMarkdownFile[]> {
    const memoryFiles = await buildMemoryDocumentIndex(this.repository.store);
    await this.externalIndex?.refresh();
    const filesByPath = new Map<string, IndexedMarkdownFile>();
    for (const file of memoryFiles) {
      filesByPath.set(file.absolutePath, file);
    }
    for (const file of this.externalIndex?.getFiles() ?? []) {
      if (!filesByPath.has(file.absolutePath)) {
        filesByPath.set(file.absolutePath, file);
      }
    }
    return [...filesByPath.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

}

/** Deeply clones mutable node fields before a lifecycle mutation. */
function cloneNode(node: ParsedMemoryNode): ParsedMemoryNode {
  return {
    slug: node.slug,
    frontMatter: {
      ...node.frontMatter,
      speaker: node.frontMatter.speaker.map((speaker) => ({ ...speaker })),
      agents: [...node.frontMatter.agents],
      tags: [...node.frontMatter.tags],
      supersedes: [...node.frontMatter.supersedes],
      links: [...node.frontMatter.links],
    },
    body: node.body,
  };
}

/** Merges a staging candidate into an existing canonical node. */
function mergeCandidate(
  target: ParsedMemoryNode,
  candidate: ParsedMemoryNode,
  timestamp: string,
): ParsedMemoryNode {
  const merged = cloneNode(target);
  const candidateBody = candidate.body.trim();
  if (
    candidateBody !== "" &&
    !merged.body
      .replace(/\s+/gu, " ")
      .includes(candidateBody.replace(/\s+/gu, " "))
  ) {
    merged.body = `${merged.body.replace(/\s+$/u, "")}\n\n${candidateBody}\n`;
  }

  merged.frontMatter.agents = unique([
    ...merged.frontMatter.agents,
    ...candidate.frontMatter.agents,
  ]);
  merged.frontMatter.tags = unique([
    ...merged.frontMatter.tags,
    ...candidate.frontMatter.tags,
  ]);
  merged.frontMatter.links = unique([
    ...merged.frontMatter.links,
    ...candidate.frontMatter.links,
  ]).filter((link) => link !== target.slug);
  merged.frontMatter.supersedes = unique([
    ...merged.frontMatter.supersedes,
    ...candidate.frontMatter.supersedes,
  ]);
  merged.frontMatter.speaker = mergeSpeakers(
    merged.frontMatter.speaker,
    candidate.frontMatter.speaker,
  );
  merged.frontMatter.edited = timestamp;
  merged.body = appendAuditEntry(
    merged.body,
    timestamp,
    `memory_promote: merged staging candidate ${candidate.slug}`,
  );
  return merged;
}

/** Compares titles and bodies after whitespace/case normalization. */
function memorySignature(title: string, body: string): string {
  return `${title}\n${body}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/** Deduplicates values while preserving their first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Merges speaker attribution records by name and confidence. */
function mergeSpeakers(
  left: MemorySpeaker[],
  right: MemorySpeaker[],
): MemorySpeaker[] {
  const merged = new Map<string, MemorySpeaker>();
  for (const speaker of [...left, ...right]) {
    const key = `${speaker.name.toLowerCase()}|${speaker.confident}|${speaker.note ?? ""}`;
    if (!merged.has(key)) {
      merged.set(key, { ...speaker });
    }
  }
  return [...merged.values()];
}

/** Converts a human title into the repository's lowercase ASCII slug format. */
export function slugifyTitle(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

  return normalized === "" ? "memory" : normalized;
}
