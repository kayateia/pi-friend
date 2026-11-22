/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  formatErrorChain,
  isDebugEnabled,
  logError,
  logNotice,
} from "../debug/log.ts";
import type {
  MemorySource,
  MemorySpeaker,
  MemoryType,
  ParsedMemoryNode,
} from "./schema.ts";
import {
  MEMORY_TYPES,
  isQuarantinedMemoryType,
  parseMemoryNode,
  serializeMemoryNode,
  validateMemoryNodeFrontMatter,
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
import type { AccessLogSource } from "./store.ts";
import { collapseSpeakers } from "./speakers.ts";

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
  /** Origin recorded for this creation, appended to the node's `sources`. */
  origin?: MemorySource;
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
  /**
   * Origin recorded when this edit changes the memory's substance. A
   * metadata-only edit writes no record: nothing about where the memory came
   * from has changed.
   */
  origin?: MemorySource;
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
  /** Origin recorded on the destination, one per merge. */
  origin?: MemorySource;
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
  /** Origin recorded for the dream, normally its sweep run. */
  origin?: MemorySource;
}

/**
 * Who asked for a search, and whether it should be logged.
 *
 * The log records every returned row, so without the source it cannot tell a
 * deliberate search from a recall block. `logAccess: false` is for the recency
 * pass: it reads memories to describe them, and a diagnostic entry would claim
 * a use that never happened.
 */
export interface SearchAuditOptions {
  source?: AccessLogSource;
  logAccess?: boolean;
  /**
   * A search corpus already built for this turn.
   *
   * Parsing every memory file is the expensive part of a search — measured at
   * ~200 ms for this store's 630 files — and a turn that recalls and then looks
   * at recency would otherwise parse the store three times. A caller doing more
   * than one retrieval in a turn builds the index once and passes it.
   */
  files?: readonly IndexedMarkdownFile[];
}

/** One memory eligible for the recency section, and why it is. */
export interface RecentMemory {
  slug: string;
  /** `edited ?? created`, normalised to a UTC instant. */
  modifiedAt: string;
  /** Inside the age window, among the newest N, or both. */
  reason: "window" | "count" | "both";
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
   * Chooses the canonical nodes a sweep shows the model as merge targets.
   *
   * A sweep used to show `canonical.slice(0, 50)`, and because the repository
   * sorts by slug that was the first fifty alphabetically: a memory could be a
   * merge target forever for no better reason than its name, and everything
   * past the cut was invisible however relevant. Relevance is what a merge
   * decision actually needs, so this embeds the whole candidate batch in one
   * request — `EmbeddingProvider.embed` takes an array — and runs one
   * nearest-neighbour query per candidate, keeping the best `perCandidate`
   * nodes and folding nodes proposed by several candidates into one entry.
   *
   * Filters travel into the vector query rather than being applied to its
   * results, so a dream or an inactive node cannot crowd out an admissible one.
   * The result is ordered by best similarity, then slug, so two sweeps over the
   * same store propose the same window.
   *
   * Returns `undefined` when semantic search is unavailable. That is the
   * caller's cue to fall back to a different window; an empty array would mean
   * "no canonical node is relevant", which is a different claim.
   */
  async selectSweepTargets(
    candidates: readonly ParsedMemoryNode[],
    mergeTargets: readonly ParsedMemoryNode[],
    perCandidate: number,
    signal?: AbortSignal,
  ): Promise<ParsedMemoryNode[] | undefined> {
    const semantic = this.semantic;
    if (!semantic) {
      return undefined;
    }
    if (candidates.length === 0 || mergeTargets.length === 0) {
      return [];
    }

    const files = await this.buildSearchIndex();
    const chunkSize = this.store.config.vector.chunkSize;
    await synchronizeVectorIndex(files, semantic.provider, semantic.index, {
      chunkSize,
      ...(signal === undefined ? {} : { signal }),
    });

    // Embed through the same function the index uses, so a candidate is a
    // query in the space its neighbours were stored in. A candidate that the
    // index has not picked up yet (a very fresh staging write) falls back to
    // the reading the prompt itself would see.
    const fileByPath = new Map(
      files.map((file) => [file.relativePath, file] as const),
    );
    const embeddings = await semantic.provider.embed(
      candidates.map((candidate) => {
        const file = fileByPath.get(`staging/${candidate.slug}.md`);
        return file === undefined
          ? [candidate.frontMatter.title, candidate.body.trim()]
              .filter((part) => part !== "")
              .join("\n\n")
          : buildEmbeddingText(file);
      }),
      signal === undefined ? undefined : { signal },
    );

    const admittedTypes = MEMORY_TYPES.filter(
      (type) => !isQuarantinedMemoryType(type),
    );
    const bestScore = new Map<string, number>();
    for (const embedding of embeddings) {
      if (embedding === undefined) {
        continue;
      }
      const results = searchSemanticVectors(
        files,
        embedding,
        {
          // The embedding is the query; the field is required by the options
          // type but `searchSemanticVectors` ranks by the vector it is given.
          query: "",
          mode: "semantic",
          limit: perCandidate,
          kinds: ["node"],
          status: "active",
          types: admittedTypes,
        },
        semantic.index,
        chunkSize,
      );
      for (const result of results) {
        if (result.slug === undefined) {
          continue;
        }
        const previous = bestScore.get(result.slug);
        if (previous === undefined || result.score > previous) {
          bestScore.set(result.slug, result.score);
        }
      }
    }

    const nodeBySlug = new Map(
      mergeTargets.map((node) => [node.slug, node] as const),
    );
    return [...bestScore.entries()]
      .sort(
        ([leftSlug, leftScore], [rightSlug, rightScore]) =>
          rightScore - leftScore ||
          (leftSlug < rightSlug ? -1 : leftSlug > rightSlug ? 1 : 0),
      )
      .flatMap(([slug]) => {
        const node = nodeBySlug.get(slug);
        return node === undefined ? [] : [node];
      });
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
          links: slugs,
          sources: input.origin === undefined ? [] : [{ ...input.origin }],
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

  /**
   * Searches all indexed Markdown files.
   *
   * `audit.source` names who asked, because the log records every returned row
   * and cannot otherwise tell a deliberate search from a recall block. It says
   * nothing about the search itself, which is why it is a parameter rather than
   * an entry in `MemorySearchOptions`.
   */
  async search(
    options: MemorySearchOptions,
    audit: SearchAuditOptions = {},
  ): Promise<MemorySearchResult[]> {
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

    const index = audit.files
      ? [...audit.files]
      : await this.buildSearchIndex();
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

    // The log is a diagnostic, not a data source: nothing reads it, so with the
    // flag off it is not written at all and its absence changes nothing. It
    // shares `PI_FRIEND_DEBUG_HOOKS` with the lifecycle dump rather than adding
    // a second switch: one debug flag to remember, and the verbosity of the
    // hooks side is acceptable because it is not a switch anyone leaves on.
    if (audit.logAccess !== false && isDebugEnabled()) {
      const source = audit.source ?? "tool";
      for (const result of results) {
        await this.repository.store.appendAccessLog({
          source,
          ...(result.slug === undefined ? {} : { slug: result.slug }),
          path: result.relativePath,
          mode,
          query: options.query,
        });
      }
    }

    return results;
  }

  /**
   * Lists the memory records the recency section may draw from.
   *
   * Eligibility is a union, not an intersection: inside the age window **or**
   * among the newest N. Both conditions are read from `edited ?? created`, the
   * content timestamp the store already defines — never from file mtime, which
   * a read now moves, and never from `decay_weight`, which measures how much
   * has been written since a use rather than when anything happened.
   *
   * Candidates are included: they are injected by recall already, so the
   * section raises their proportion rather than introducing them. Dreams are
   * not — they are quarantined from factual injection everywhere else.
   *
   * Returns the pool in chronological order, which is the order it is rendered.
   */
  async recentPool(options: {
    maxAgeSeconds: number;
    lastN: number;
    now?: Date;
    /** A corpus already built for this turn; see {@link searchFiles}. */
    files?: readonly IndexedMarkdownFile[];
  }): Promise<RecentMemory[]> {
    const files =
      options.files ?? (await buildMemoryDocumentIndex(this.repository.store));
    const now = (options.now ?? this.now()).getTime();

    const dated = files.flatMap((file) => {
      if (file.slug === undefined || file.modifiedAt === undefined) {
        return [];
      }
      const isMemory =
        (file.kind === "node" && file.status === "active") ||
        (file.kind === "staging-candidate" && file.status === "candidate");
      if (!isMemory) {
        return [];
      }
      if (file.type !== undefined && isQuarantinedMemoryType(file.type)) {
        return [];
      }
      return [{ slug: file.slug, at: Date.parse(file.modifiedAt), modifiedAt: file.modifiedAt }];
    });

    const windowStart =
      options.maxAgeSeconds > 0 ? now - options.maxAgeSeconds * 1_000 : Infinity;
    const inWindow = new Set(
      dated.filter((entry) => entry.at >= windowStart).map((entry) => entry.slug),
    );
    const newest = new Set(
      options.lastN > 0
        ? [...dated]
            .sort((left, right) => right.at - left.at || (left.slug < right.slug ? -1 : 1))
            .slice(0, options.lastN)
            .map((entry) => entry.slug)
        : [],
    );

    return dated
      .filter((entry) => inWindow.has(entry.slug) || newest.has(entry.slug))
      .map((entry): RecentMemory => ({
        slug: entry.slug,
        modifiedAt: entry.modifiedAt,
        reason: inWindow.has(entry.slug)
          ? newest.has(entry.slug)
            ? "both"
            : "window"
          : "count",
      }))
      .sort((left, right) =>
        left.modifiedAt < right.modifiedAt
          ? -1
          : left.modifiedAt > right.modifiedAt
            ? 1
            : left.slug < right.slug
              ? -1
              : 1,
      );
  }

  /**
   * Records that memories were used, at the point of use.
   *
   * `last_used` and `use_count` are written here rather than projected at the
   * next sweep, so a read is visible immediately and the access log stops being
   * the store of record for it. The callers are the ones that know what a use
   * *was*: the tool surface passes every row it returned, and the recall pass
   * passes only what reached the prompt.
   *
   * Candidates are not bumped. Their decay deliberately ignores retrieval, so a
   * bumped candidate would keep whatever the retriever happens to like from ever
   * reaching the floor. Documents have no counters. Both fall out of reading the
   * canonical area by slug, which is also why a stale slug is a no-op rather
   * than an error.
   *
   * `edited` is never touched: it dates authorship, not attention, and the
   * record's content timestamp depends on it.
   *
   * A failure here is logged, never thrown. Failing to record a use is a reason
   * for one log line, not for failing the search that found the memory.
   */
  async recordUse(slugs: readonly string[]): Promise<void> {
    const unique = [...new Set(slugs.filter((slug) => slug.trim() !== ""))];
    if (unique.length === 0) {
      return;
    }
    const now = this.now().toISOString();
    try {
      await this.runSerialized(async () => {
        for (const slug of unique) {
          try {
            const node = await this.repository.read(slug, "canonical");
            if (node === null) {
              continue;
            }
            node.frontMatter.last_used = now;
            node.frontMatter.use_count = node.frontMatter.use_count + 1;
            await this.repository.write(node, "canonical");
          } catch (error) {
            logError(`memory use bump for "${slug}"`, error);
          }
        }
      });
    } catch (error) {
      logError("memory use bump", error);
    }
  }

  /**
   * Recomputes volume-relative decay metadata for canonical nodes.
   *
   * Weight only. `last_used` and `use_count` are written where the use happens
   * (see {@link recordUse}), so a sweep no longer projects them from a log and
   * a read is visible immediately rather than at the next pass.
   */
  async recomputeDecay(): Promise<DecayUpdate[]> {
    return this.runSerialized(async () => {
      const nodes = await this.repository.list("canonical");
      const updates = computeDecayUpdates(nodes);
      const bySlug = new Map(nodes.map((node) => [node.slug, node]));

      for (const update of updates) {
        const node = bySlug.get(update.slug);
        if (!node) continue;
        node.frontMatter.decay_weight = update.decayWeight;
        await this.repository.write(node, "canonical");
      }

      return updates;
    });
  }

  /** Writes planned staging decay weights before sweep decisions are applied. */
  async applyCandidateDecay(updates: DecayUpdate[]): Promise<void> {
    return this.runSerialized(async () => {
      for (const update of updates) {
        const candidate = await this.repository.read(update.slug, "staging");
        if (candidate === null) {
          continue;
        }
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
          speaker: this.speakersFor(input.speaker, slug),
          agents: input.agents ?? [],
          created: timestamp,
          last_used: timestamp,
          use_count: 0,
          decay_weight: 1,
          status: "active",
          emotional_flavour: input.emotionalFlavour ?? "neutral",
          tags: input.tags ?? [],
          links: input.links ?? [],
          sources: input.origin === undefined ? [] : [{ ...input.origin }],
        },
      };

      // Format first, so a malformed slug is reported by the schema; then the
      // claim the links make about other memories.
      validateMemoryNodeFrontMatter(
        node.frontMatter as unknown as Record<string, unknown>,
        slug,
      );
      await this.checkLinks(node.frontMatter.links, slug);

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

      // A captured link is a guess, and a guess that names no memory is worth
      // less than the draft it would otherwise cost.
      const links = await this.existingLinks(input.links ?? [], slug);

      const timestamp = this.now().toISOString();
      const node: ParsedMemoryNode = {
        slug,
        body: `\n${body}\n`,
        frontMatter: {
          title: input.title.trim(),
          type: input.type,
          speaker: this.speakersFor(input.speaker, slug),
          agents: input.agents ?? [],
          created: timestamp,
          last_used: timestamp,
          use_count: 0,
          decay_weight: 1,
          status: "candidate",
          emotional_flavour: input.emotionalFlavour ?? "neutral",
          tags: input.tags ?? [],
          links,
          sources: input.origin === undefined ? [] : [{ ...input.origin }],
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
          `Cannot merge a staging candidate into ${target.frontMatter.type} memory "${target.slug}"; a dream is synthesized from memories and is never a merge target.`,
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
          `Cannot merge into ${target.frontMatter.type} memory "${target.slug}"; a dream is synthesized from memories and is never a merge target.`,
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
      if (options.origin !== undefined) {
        merged.frontMatter.sources = [
          ...merged.frontMatter.sources,
          { ...options.origin },
        ];
      }
      merged.frontMatter.edited = now;
      // A merge is an edit, and an edit is a use: the node was opened, reasoned
      // about and rewritten. It does not count as a *read*, so `use_count` is
      // left alone.
      merged.frontMatter.last_used = now;
      // Attribution from every source is pooled and collapsed once, rather than
      // unioned as-is: two memories can each name the same person, and a list
      // that repeats them reads as a contradiction in the recall block.
      merged.frontMatter.speaker = this.speakersFor(
        [
          ...merged.frontMatter.speaker,
          ...sourceNodes.flatMap((node) => node.frontMatter.speaker),
        ],
        target.slug,
      );
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
      }

      await this.repository.write(merged, "canonical");
      for (const source of sources) {
        await this.repository.remove(source.node.slug, source.area);
      }
      await this.retargetIncomingLinks(
        new Set(sources.map((source) => source.node.slug)),
        target.slug,
      );

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

  /**
   * Updates editable node fields, preserving creation state.
   *
   * An edit is always a use: the node was opened and reasoned about, so
   * `last_used` moves on every edit and `use_count` does not — it counts reads,
   * not authorship.
   *
   * `edited` is the content timestamp, and it moves only when the memory's
   * claim changes: its `title`, its `speaker`, or its `body`. `type`, `tags`,
   * `links`, `emotional_flavour`, `source` and `agents` are filing, graph edges,
   * tone and provenance — true statements about the memory, but not the memory
   * saying something different — and a value supplied unchanged is not a change
   * at all. The recency section, the listings, the search date filters and the
   * sync conflict rule all read this date, so a retag that moved it would make
   * an old memory look like something that had just happened.
   */
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
        links: [...node.frontMatter.links],
      };

      if (input.type !== undefined) frontMatter.type = input.type;
      if (input.agents !== undefined) frontMatter.agents = input.agents;
      if (input.emotionalFlavour !== undefined) {
        frontMatter.emotional_flavour = input.emotionalFlavour;
      }
      if (input.tags !== undefined) frontMatter.tags = input.tags;
      if (input.links !== undefined) frontMatter.links = input.links;

      // The three fields that change what the memory claims. Each is compared
      // rather than merely supplied: sending back the value the node already
      // has is a write, not a change, and it must not look like one.
      let substantive = false;

      if (input.title !== undefined && input.title !== node.frontMatter.title) {
        frontMatter.title = input.title;
        substantive = true;
      }
      if (input.speaker !== undefined) {
        const speaker = this.speakersFor(input.speaker, node.slug);
        frontMatter.speaker = speaker;
        if (!sameSpeakers(speaker, node.frontMatter.speaker)) {
          substantive = true;
        }
      }

      let body = node.body;
      if (input.body !== undefined) {
        const updatedBody = input.body.trim();
        if (updatedBody === "") {
          throw new MemoryServiceError("Memory body must not be empty.");
        }
        body = `\n${updatedBody}\n`;
        if (updatedBody !== node.body.trim()) {
          substantive = true;
        }
      }

      if (substantive) {
        frontMatter.edited = timestamp;
        if (input.origin !== undefined) {
          frontMatter.sources = [...frontMatter.sources, { ...input.origin }];
        }
      }
      frontMatter.last_used = timestamp;
      const updated: ParsedMemoryNode = {
        slug: node.slug,
        frontMatter,
        body,
      };

      // Checked before anything is archived: a refused edit must leave no
      // history entry behind, or the store would carry a version of an edit
      // that never happened.
      validateMemoryNodeFrontMatter(
        updated.frontMatter as unknown as Record<string, unknown>,
        node.slug,
      );
      if (input.links !== undefined) {
        await this.checkLinks(updated.frontMatter.links, node.slug);
      }

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

      // A link to a memory that no longer exists is a claim nothing can check;
      // removing it here keeps the store's links resolvable without asking
      // anyone to remember.
      await this.dropIncomingLinks(target.node.slug);

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
        restored.frontMatter.speaker = this.speakersFor(
          restored.frontMatter.speaker,
          validSlug,
        );
        restored.frontMatter.status = "candidate";
        restored.frontMatter.decay_weight = 1;
        restored.frontMatter.last_used = now;
        // A candidate is never edited, so the archived copy's `edited` — if an
        // older build wrote one — describes nothing, and the staging schema
        // refuses it. Restoring is a copy, so it is removed rather than left
        // for the next writer to trip over.
        delete restored.frontMatter.edited;
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
      restored.frontMatter.speaker = this.speakersFor(
        restored.frontMatter.speaker,
        validSlug,
      );
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
   *
   * The clock is the service's, not the wall's. Retention compares a version's
   * timestamp against a cutoff, and the timestamps this service writes come
   * from `now` — so reading the real clock here would make an operation judge
   * its own output against a different calendar, which is how a version
   * written at fixture-time and pruned at wall-time disappeared.
   */
  private async pruneHistoryFor(kind: HistoryKind, slug: string): Promise<void> {
    await pruneHistorySlug(this.repository.store, kind, slug, this.now()).catch(
      (error: unknown) => logError("history retention", error),
    );
  }

  /**
   * Collapses attribution for one write, naming the memory if a caveat is lost.
   *
   * The collapse is the invariant: one record per person per memory. It is
   * applied at write time rather than at display time, because a formatter that
   * repaired attribution would be a second place to be right and would hide the
   * violation instead of preventing it.
   */
  /**
   * Refuses a link that names nothing, or names the node itself.
   *
   * A link is a claim that another memory exists and is related; a typo turns
   * that claim into a dead end that nothing ever notices, because the one
   * consumer of links ignores entries it cannot resolve. The check runs after
   * the schema has validated the format, so a malformed slug is still reported
   * with the schema's message rather than as a missing memory.
   */
  private async checkLinks(
    links: readonly string[],
    slug: string,
  ): Promise<void> {
    for (const link of links) {
      if (link === slug) {
        throw new MemoryServiceError(
          `A memory must not link to itself ("${slug}").`,
        );
      }
      if ((await this.repository.read(link, "canonical")) === null) {
        throw new MemoryServiceError(
          `Link "${link}" in ${slug} does not name an existing memory. Check the slug with memory_search, or create the memory first.`,
        );
      }
    }
  }

  /**
   * Keeps the links that resolve, dropping the rest without complaint.
   *
   * The capture path cannot stop for one bad guess: a draft is a proposal read
   * from a conversation, and a link it invented should cost that link rather
   * than the batch. Malformed slugs are left in place for the schema to refuse,
   * because a test with a duplicated link is testing exactly that.
   */
  private async existingLinks(
    links: readonly string[],
    slug: string,
  ): Promise<string[]> {
    const kept: string[] = [];
    for (const link of links) {
      try {
        validateSlug(link);
      } catch {
        kept.push(link);
        continue;
      }
      if (link === slug) {
        continue;
      }
      if ((await this.repository.read(link, "canonical")) !== null) {
        kept.push(link);
      }
    }
    return kept;
  }

  /**
   * Removes every link to a slug that has just left the canonical area.
   *
   * Called after the node is gone, not before: a failed removal leaves the
   * memory in place, and its links should stay as they were.
   */
  private async dropIncomingLinks(slug: string): Promise<void> {
    for (const node of await this.repository.list("canonical")) {
      if (!node.frontMatter.links.includes(slug)) {
        continue;
      }
      node.frontMatter.links = node.frontMatter.links.filter(
        (link) => link !== slug,
      );
      await this.repository.write(node);
    }
  }

  /**
   * Points links at a slug that has just left the canonical area to its
   * replacement.
   *
   * A merge is a replacement, not a deletion: a memory that linked to one of
   * the absorbed nodes should still be able to follow the thread, and the
   * surviving node is where the content now lives. Links that land on the
   * target twice are collapsed, and a node is never left linking to itself.
   */
  private async retargetIncomingLinks(
    removed: ReadonlySet<string>,
    target: string,
  ): Promise<void> {
    if (removed.size === 0) {
      return;
    }
    for (const node of await this.repository.list("canonical")) {
      if (node.slug === target) {
        continue;
      }
      let changed = false;
      const links: string[] = [];
      for (const link of node.frontMatter.links) {
        const next = removed.has(link) ? target : link;
        if (next !== link) {
          changed = true;
        }
        if (next !== node.slug && !links.includes(next)) {
          links.push(next);
        } else if (next === node.slug) {
          changed = true;
        }
      }
      if (!changed) {
        continue;
      }
      node.frontMatter.links = links;
      await this.repository.write(node);
    }
  }

  private speakersFor(
    speakers: readonly MemorySpeaker[],
    slug: string,
  ): MemorySpeaker[] {
    return collapseSpeakers(speakers, {
      slug,
      reportDiscardedCaveat: (message) =>
        logNotice("speaker attribution", message),
    });
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

  /**
   * Builds the corpus a search runs over, for a caller doing several in a turn.
   *
   * Each call re-reads and re-parses the store, so a caller that searches more
   * than once should take this once and pass the result through
   * `SearchAuditOptions.files`.
   */
  async searchFiles(): Promise<IndexedMarkdownFile[]> {
    return this.buildSearchIndex();
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

/**
 * Compares two attribution lists by their normalised content.
 *
 * Both sides arrive collapsed — the stored node from the parser, the supplied
 * list from `speakersFor` — so this is an equality check, not a merge. A note
 * that is absent and a note that is empty are the same attribution; the schema
 * writes one and reads the other back.
 */
function sameSpeakers(
  left: readonly MemorySpeaker[],
  right: readonly MemorySpeaker[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((speaker, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      speaker.name === other.name &&
      speaker.confident === other.confident &&
      (speaker.note ?? "") === (other.note ?? "")
    );
  });
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
      links: [...node.frontMatter.links],
      sources: node.frontMatter.sources.map((source) => ({ ...source })),
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
