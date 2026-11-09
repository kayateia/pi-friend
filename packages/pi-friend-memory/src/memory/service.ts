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
import type { HistoryKind } from "./history.ts";
import type { MergeRewrite, MergeWriter } from "./merge-writer.ts";
import { toMergeSource } from "./merge-writer.ts";
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
import {
  compileSpeakerTagPatterns,
  stripSpeakerTag,
  type CompiledSpeakerTagPattern,
} from "./speaker-tags.ts";
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
  emotionalFlavour?: string;
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
  emotionalFlavour?: string;
  tags?: string[];
  links?: string[];
  source?: string;
  reason?: string;
}

/** Result of moving one live node into the history tree. */
export interface MemoryDeletionResult {
  slug: string;
  /**
   * Which area the node left. A deleted memory comes back canonical, a dropped
   * candidate staged, so the caller needs this to phrase the undo.
   */
  area: MemoryNodeArea;
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
  /** Where the copy landed: a deleted memory comes back canonical, a drop staged. */
  restoredTo: "canonical" | "staging";
}

/** Result of staging one auto-captured candidate. */
export interface MemoryStageResult {
  node: ParsedMemoryNode;
  created: boolean;
}

/** Options for one merge. */
export interface MergeOptions {
  /** Caller-supplied body; skips the writer entirely. */
  body?: string;
  /** Conflict note used when the writer does not supply one. */
  conflict?: string;
  reportWarning?: (message: string) => void;
}

/** Result of merging one or more memories into a canonical node. */
export interface MemoryMergeResult {
  node: ParsedMemoryNode;
  mergedInto: string;
  /** Slugs removed from canonical memory, as opposed to from staging. */
  removedMemories: string[];
  /** Slugs removed from staging. */
  removedCandidates: string[];
  /** False when the writer failed and the mechanical append was used instead. */
  rewritten: boolean;
  /** True when the caller supplied the body and the writer was not consulted. */
  bodySupplied: boolean;
  rewriteError?: string;
}

/** Result of promoting one staging candidate. */
export interface MemoryPromotionResult {
  node: ParsedMemoryNode;
  merged: boolean;
  /** For a merge, false when the writer failed and bodies were appended. */
  rewritten?: boolean;
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
  private readonly mergeWriter: MergeWriter | undefined;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(
    repository: MemoryNodeRepository,
    now: () => Date = () => new Date(),
    semantic: SemanticSearchDependencies | undefined = undefined,
    externalIndex: ExternalIndexSource | undefined = undefined,
    mergeWriter: MergeWriter | undefined = undefined,
  ) {
    this.repository = repository;
    this.now = now;
    this.semantic = semantic;
    this.externalIndex = externalIndex;
    this.mergeWriter = mergeWriter;
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
          node.frontMatter.emotional_flavour ||
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
          emotional_flavour: "dreamlike",
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
    // A speaker tag marks who is speaking and is not part of what was asked, so
    // it leaves the query before keyword matching, the embedding and the access
    // log see it. The names it carried are not thrown away: a memory attributed
    // to the person speaking is more relevant to this conversation, and that is
    // the one thing a tag is allowed to score.
    const { text: query, tags } = this.prepareQuery(options.query);
    if (query.trim() === "") {
      throw new MemoryServiceError("Search query must not be empty.");
    }
    const speakerNames = [...new Set(tags.map((tag) => tag.name))];
    if (options.corpus !== undefined && options.kinds !== undefined) {
      throw new MemoryServiceError(
        "Search options cannot set both corpus and kinds.",
      );
    }
    const cleaned: MemorySearchOptions = { ...options, query, ...(speakerNames.length === 0 ? {} : { speakerNames }) };
    const resolved: MemorySearchOptions =
      cleaned.corpus === undefined
        ? cleaned
        : { ...cleaned, kinds: kindsForCorpus(cleaned.corpus) };

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
        mode,
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
          emotional_flavour: input.emotionalFlavour ?? "neutral",
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
          emotional_flavour: input.emotionalFlavour ?? "neutral",
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
    options: { conflict?: string; reportWarning?: (message: string) => void } = {},
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
      if (target === null && this.semantic) {
        target = await this.findPromotionDuplicate(candidate);
      }
      if (target !== null && isQuarantinedMemoryType(target.frontMatter.type)) {
        throw new MemoryServiceError(
          `Cannot merge a staging candidate into ${target.frontMatter.type} memory "${target.slug}".`,
        );
      }

      if (target !== null) {
        const result = await this.mergeCandidatesLocked(
          target.slug,
          [candidate.slug],
          options,
        );
        return {
          node: result.node,
          merged: true,
          mergedInto: target.slug,
          rewritten: result.rewritten,
        };
      }

      const promoted = cloneNode(candidate);
      promoted.frontMatter.status = "active";
      promoted.frontMatter.decay_weight = 1;
      promoted.frontMatter.last_used = now;
      promoted.frontMatter.edited = now;
      promoted.frontMatter.superseded_by = "";

      await this.repository.write(promoted, "canonical");
      await this.repository.remove(candidate.slug, "staging");
      return { node: promoted, merged: false };
    });
  }

  /**
   * Merges staging candidates into one canonical node.
   *
   * Grouped by target rather than one call per decision: several candidates
   * landing in the same memory are one consolidation, and rewriting it once
   * from all of them is both cheaper and more coherent than rewriting it
   * repeatedly from each intermediate result.
   *
   * The merged body comes from the configured writer when one exists. If it
   * fails, the mechanical append that predates it is used instead and the
   * failure is reported — a merge that cannot be written well should still
   * happen, because refusing it re-offers the same candidates every sweep.
   */
  async mergeCandidates(
    targetSlug: string,
    candidateSlugs: string[],
    options: MergeOptions = {},
  ): Promise<MemoryMergeResult> {
    return this.runSerialized(() =>
      this.mergeCandidatesLocked(targetSlug, candidateSlugs, options),
    );
  }

  /**
   * The merge itself, assuming the caller already holds the mutation lock.
   *
   * `promoteCandidate` calls this directly: it is already serialized, and a
   * nested `runSerialized` would queue behind its own lock and hang.
   */
  private async mergeCandidatesLocked(
    targetSlug: string,
    candidateSlugs: string[],
    options: MergeOptions = {},
  ): Promise<MemoryMergeResult> {
      if (candidateSlugs.length === 0) {
        throw new MemoryServiceError("A merge needs at least one candidate.");
      }
      const target = await this.repository.read(targetSlug, "canonical");
      if (target === null) {
        throw new MemoryServiceError(
          `Merge target "${targetSlug}" does not exist.`,
        );
      }
      if (isQuarantinedMemoryType(target.frontMatter.type)) {
        throw new MemoryServiceError(
          `Cannot merge into ${target.frontMatter.type} memory "${target.slug}".`,
        );
      }

      const sources: Array<{
        node: ParsedMemoryNode;
        area: MemoryNodeArea;
      }> = [];
      const seen = new Set<string>();
      for (const slug of candidateSlugs) {
        if (slug === target.slug) {
          throw new MemoryServiceError(
            `Cannot merge "${target.slug}" into itself.`,
          );
        }
        if (seen.has(slug)) {
          continue;
        }
        seen.add(slug);
        // A source can be a canonical memory, as in a manual merge of two
        // nodes, or a staging candidate, as in a sweep verdict. Both are
        // archived the same way and both leave the area they came from.
        const canonical = await this.repository.read(slug, "canonical");
        if (canonical !== null) {
          sources.push({ node: canonical, area: "canonical" });
          continue;
        }
        const staged = await this.repository.read(slug, "staging");
        if (staged === null) {
          throw new MemoryServiceError(
            `No memory or staging candidate found for "${slug}".`,
          );
        }
        sources.push({ node: staged, area: "staging" });
      }

      const now = this.now().toISOString();
      const sourceNodes = sources.map((source) => source.node);

      // A caller that supplies the body owns the wording and is expected to know
      // what it is doing; the writer is only consulted when it did not.
      let rewrite: MergeRewrite | undefined;
      let rewriteError: string | undefined;
      const suppliedBody = options.body?.trim();
      if (suppliedBody !== undefined && suppliedBody !== "") {
        rewrite = { body: suppliedBody };
      } else if (this.mergeWriter !== undefined) {
        try {
          rewrite = await this.mergeWriter(
            [target, ...sourceNodes].map(toMergeSource),
          );
        } catch (error) {
          rewriteError = formatErrorChain(error);
        }
      }

      const conflict = (rewrite?.conflict ?? options.conflict)?.trim();
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
      for (const candidate of sourceNodes) {
        await writeHistoryEntry(this.repository.store, {
          kind: "merged",
          slug: candidate.slug,
          timestamp: now,
          node: cloneNode(candidate),
        });
      }
      await this.pruneHistoryFor("merged", target.slug);
      for (const candidate of sourceNodes) {
        await this.pruneHistoryFor("merged", candidate.slug);
      }

      const merged = cloneNode(target);
      merged.body = rewrite?.body ?? appendMechanically(target, sourceNodes);
      merged.frontMatter.edited = now;
      for (const candidate of sourceNodes) {
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
      }

      await this.repository.write(merged, "canonical");
      for (const source of sources) {
        await this.repository.remove(source.node.slug, source.area);
      }

      if (rewriteError !== undefined) {
        logError("memory merge writer", new Error(rewriteError));
        options.reportWarning?.(
          `pi-friend memory: merging into "${target.slug}" used the mechanical append because the merge writer failed (${rewriteError}).`,
        );
      }

      return {
        node: merged,
        mergedInto: target.slug,
        removedMemories: sources
          .filter((source) => source.area === "canonical")
          .map((source) => source.node.slug),
        removedCandidates: sources
          .filter((source) => source.area === "staging")
          .map((source) => source.node.slug),
        rewritten: rewrite !== undefined,
        bodySupplied: suppliedBody !== undefined && suppliedBody !== "",
        ...(rewriteError === undefined ? {} : { rewriteError }),
      };
  }

  /**
   * Moves one dropped staging candidate into history.
   *
   * The file is the candidate as it was, so a person can read what the sweep
   * threw away. A slug that was staged and dropped twice keeps the newer copy:
   * a drop is a decision about a candidate, not an accumulating record.
   */
  async archiveCandidate(slug: string): Promise<string> {
    return this.runSerialized(() => this.archiveCandidateLocked(slug));
  }

  /** The drop itself, assuming the caller already holds the mutation lock. */
  private async archiveCandidateLocked(slug: string): Promise<string> {
    const candidate = await this.repository.read(slug, "staging");
    if (candidate === null) {
      throw new MemoryServiceError(`No staging candidate found for "${slug}".`);
    }
    const relativePath = await writeHistoryEntry(this.repository.store, {
      kind: "dropped",
      slug,
      node: cloneNode(candidate),
    });
    await this.repository.remove(slug, "staging");
    return relativePath;
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
        input.emotionalFlavour,
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
      if (input.emotionalFlavour !== undefined) {
        frontMatter.emotional_flavour = input.emotionalFlavour;
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
   * Moves exactly one matching live node into the history tree.
   *
   * Both live areas are searched. The area decides the entry: a canonical
   * memory is archived as `deleted`, while a staging candidate is archived as
   * `dropped` — the same entry the sweep writes when its model rejects a
   * candidate — so a candidate a person knows to be false is recoverable by
   * exactly the route the sweep's own rejections are. The archived copy is
   * written before the live file is removed, and it is the node exactly as it
   * was, so restoring is a copy rather than a reconstruction. Ambiguous
   * substring matches are rejected so a broad request cannot delete several
   * nodes by accident; slugs are unique across the live areas, so an exact slug
   * never has to choose between them.
   */
  async delete(match: string): Promise<MemoryDeletionResult> {
    return this.runSerialized(async () => {
      const query = match.trim();
      if (query === "") {
        throw new MemoryServiceError("Delete match must not be empty.");
      }

      // Canonical first so an ambiguity is listed memories before candidates,
      // which is the order the question is usually asked in.
      const live = [
        ...(await this.repository.list("canonical")).map((node) => ({
          node,
          area: "canonical" as MemoryNodeArea,
        })),
        ...(await this.repository.list("staging")).map((node) => ({
          node,
          area: "staging" as MemoryNodeArea,
        })),
      ];

      const normalizedQuery = query.toLowerCase();
      let target = live.find((entry) => entry.node.slug === normalizedQuery);
      if (!target) {
        const matches = live.filter((entry) =>
          [
            entry.node.slug,
            entry.node.frontMatter.title,
            entry.node.frontMatter.tags.join(" "),
            entry.node.body,
          ]
            .join("\n")
            .toLowerCase()
            .includes(normalizedQuery),
        );

        if (matches.length === 0) {
          throw new MemoryServiceError(
            `No memory or staging candidate matches "${query}".`,
          );
        }
        if (matches.length > 1) {
          throw new MemoryServiceError(
            `"${query}" is ambiguous: ${matches
              .map(
                (entry) =>
                  `${entry.node.slug} (${
                    entry.area === "staging" ? "candidate" : "memory"
                  })`,
              )
              .join(", ")}. Use an exact slug or a narrower match.`,
          );
        }
        target = matches[0];
      }

      if (target.area === "staging") {
        const historyPath = await this.archiveCandidateLocked(target.node.slug);
        return {
          slug: target.node.slug,
          area: "staging",
          historyPath,
          original: cloneNode(target.node),
        };
      }

      const original = cloneNode(target.node);
      const historyPath = await writeHistoryEntry(this.repository.store, {
        kind: "deleted",
        slug: target.node.slug,
        node: cloneNode(target.node),
      });
      try {
        await this.repository.remove(target.node.slug, "canonical");
      } catch (error) {
        // The node is still canonical, so the archive would claim a deletion
        // that did not happen. Drop it and let the failure stand.
        await this.repository.store.removeTextFile(historyPath).catch(() => {});
        throw error;
      }

      return {
        slug: target.node.slug,
        area: "canonical",
        historyPath,
        original,
      };
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
            (await this.findNewestVersion(validSlug)) ??
            (await this.findDroppedEntry(validSlug)))
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

      if (relativePath.startsWith("history/dropped/")) {
        // A dropped candidate is not a memory: it goes back into staging, where
        // the next sweep can consider it again. Replacing a live memory with an
        // unverified draft is not what restoring a candidate should mean, so a
        // canonical node of the same slug is a refusal rather than an overwrite.
        if ((await this.repository.read(validSlug)) !== null) {
          throw new MemoryServiceError(
            `Cannot restore dropped candidate "${validSlug}" because a canonical memory with that slug exists.`,
          );
        }
        if ((await this.repository.read(validSlug, "staging")) !== null) {
          throw new MemoryServiceError(
            `Cannot restore dropped candidate "${validSlug}" because a staging candidate with that slug exists.`,
          );
        }
        const restored = cloneNode(archived);
        restored.frontMatter = stripHistoryFields(restored.frontMatter);
        restored.frontMatter.status = "candidate";
        restored.frontMatter.decay_weight = 1;
        restored.frontMatter.last_used = now;
        restored.frontMatter.edited = now;
        await this.repository.write(restored, "staging");
        await this.repository.store.removeTextFile(relativePath);
        return {
          slug: validSlug,
          node: restored,
          replaced: false,
          restoredFrom: relativePath,
          removedChildren: [],
          missingChildren: [],
          restoredTo: "staging",
        };
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
        restoredTo: "canonical",
      };
    });
  }

  /** Returns the slug's dropped-candidate entry path when one exists. */
  private async findDroppedEntry(slug: string): Promise<string | null> {
    const relativePath = historyEntryPath("dropped", slug);
    const text = await this.repository.store.readTextFileIfExists(relativePath);
    return text === null ? null : relativePath;
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

  /**
   * Splits a query into the text that will be matched and the names its tags
   * carried. Public because the diagnostic reports the text that was searched,
   * not the message it came from.
   */
  prepareQuery(query: string): {
    text: string;
    tags: ReturnType<typeof stripSpeakerTag>["tags"];
  } {
    const { text, tags } = stripSpeakerTag(query, this.speakerTagPatterns());
    return { text, tags };
  }

  /** Compiled tag patterns, built once per service. */
  private speakerTagCache: CompiledSpeakerTagPattern[] | undefined;

  private speakerTagPatterns(): CompiledSpeakerTagPattern[] {
    this.speakerTagCache ??= compileSpeakerTagPatterns(
      this.store.config.speakerTags.patterns,
    );
    return this.speakerTagCache;
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

/**
 * Concatenates bodies the way merges worked before the writer existed.
 *
 * Used when no writer is configured, and as the fallback when one fails: it
 * cannot lose a fact, because it never rewrites anything, so a bad merge pass
 * degrades to the old behaviour rather than to a hole.
 */
function appendMechanically(
  target: ParsedMemoryNode,
  candidates: ParsedMemoryNode[],
): string {
  let body = target.body;
  for (const candidate of candidates) {
    const candidateBody = candidate.body.trim();
    if (
      candidateBody !== "" &&
      !body
        .replace(/\s+/gu, " ")
        .includes(candidateBody.replace(/\s+/gu, " "))
    ) {
      body = `${body.replace(/\s+$/u, "")}\n\n${candidateBody}\n`;
    }
  }
  return body;
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
