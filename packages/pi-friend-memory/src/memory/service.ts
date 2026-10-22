/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import type {
  MemorySpeaker,
  MemoryType,
  ParsedMemoryNode,
} from "./schema.ts";
import {
  parseMemoryNode,
  serializeMemoryNode,
} from "./schema.ts";
import { validateSlug } from "./paths.ts";
import { appendAuditEntry } from "./audit.ts";
import type { NodeRecoveryRecord } from "./recovery.ts";
import {
  parseRecoveryRecord,
  RecoveryRecordError,
} from "./recovery.ts";
import { buildMemoryDocumentIndex } from "./indexer.ts";
import { searchHybrid } from "./hybrid-search.ts";
import type { EmbeddingProvider } from "./embedding.ts";
import type {
  MemorySearchOptions,
  MemorySearchResult,
} from "./search.ts";
import { searchIndexedFiles } from "./search.ts";
import { searchSemantically } from "./semantic-search.ts";
import type { VectorIndex } from "./vector-index.ts";
import { buildEmbeddingText } from "./vector-sync.ts";
import { synchronizeVectorIndex } from "./vector-sync.ts";
import { searchSemanticVectors } from "./semantic-search.ts";
import {
  computeDecayUpdates,
  type DecayUpdate,
} from "./decay.ts";
import { formatDailyEntry, localDate } from "./daily.ts";
import type {
  MemoryNodeArea,
  MemoryNodeRepository,
} from "./repository.ts";

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

/** Result of moving one canonical node into superseded storage. */
export interface MemoryDeletionResult {
  recoveryId: string;
  original: ParsedMemoryNode;
  tombstone: ParsedMemoryNode;
}

/** Result of restoring a node from a durable recovery record. */
export interface MemoryRestorationResult {
  recoveryId: string;
  node: ParsedMemoryNode;
  alreadyRestored: boolean;
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

/** Result of appending one daily-log note. */
export interface DailyLogWriteResult {
  date: string;
  path: string;
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
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    repository: MemoryNodeRepository,
    now: () => Date = () => new Date(),
    semantic: SemanticSearchDependencies | undefined = undefined,
  ) {
    this.repository = repository;
    this.now = now;
    this.semantic = semantic;
  }

  /** Storage handle used by sweep artifact/state management. */
  get store() {
    return this.repository.store;
  }

  /** Lists staging candidates for sweep decisions. */
  async listStagingCandidates(): Promise<ParsedMemoryNode[]> {
    return this.repository.list("staging");
  }

  /** Lists canonical nodes for sweep decisions and decay. */
  async listCanonicalNodes(): Promise<ParsedMemoryNode[]> {
    return this.repository.list("canonical");
  }

  /** Appends one timestamped note to a local-calendar daily log. */
  async appendDailyNote(
    content: string,
    options: {
      sessionId: string;
      timestamp?: Date;
    },
  ): Promise<DailyLogWriteResult> {
    const text = content.trim();
    if (text === "") {
      throw new MemoryServiceError("Daily log content must not be empty.");
    }
    const timestamp = options.timestamp ?? this.now();
    const date = localDate(timestamp);
    const relative = `daily/${date}.md`;
    const existing =
      (await this.repository.store.readTextFileIfExists(relative)) ?? "";
    const separator = existing.trim() ? "\n" : "";
    await this.repository.store.appendDaily(
      date,
      `${separator}${formatDailyEntry(
        timestamp.toISOString(),
        options.sessionId,
        text,
      )}`,
    );
    return { date, path: relative };
  }

  /** Archives superseded tombstones whose grace period has elapsed. */
  async archiveExpiredTombstones(
    graceDays: number,
    runId: string,
    now: Date = new Date(),
  ): Promise<{
    archived: Array<{ slug: string; path: string }>;
    retained: number;
  }> {
    return this.runSerialized(async () => {
      const tombstones = await this.repository.list("superseded");
      const archived: Array<{ slug: string; path: string }> = [];
      let retained = 0;
      const threshold = now.getTime() - graceDays * 24 * 60 * 60 * 1_000;

      for (const node of tombstones) {
        const timestamp =
          node.frontMatter.edited ?? node.frontMatter.created;
        const parsed = Date.parse(timestamp);
        if (!Number.isFinite(parsed) || parsed > threshold) {
          retained += 1;
          continue;
        }
        const path = `sweeps/archived/${runId}/${node.slug}.md`;
        await this.repository.store.writeTextFile(
          path,
          serializeMemoryNode(node),
        );
        await this.repository.remove(node.slug, "superseded");
        archived.push({ slug: node.slug, path });
      }
      return { archived, retained };
    });
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
          node.frontMatter.type === "dream"
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
        (node) =>
          `- ${node.frontMatter.title} (nodes/${node.slug}.md)`,
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
          source:
            input.source ??
            `dream; sources: ${slugs.join(", ")}`,
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
  async search(
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    if (options.query.trim() === "") {
      throw new MemoryServiceError("Search query must not be empty.");
    }

    const index = await buildMemoryDocumentIndex(this.repository.store);
    const mode = options.mode ?? "keyword";
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
              options,
              this.semantic.provider,
              this.semantic.index,
            )
          : await searchSemantically(
              index,
              options,
              this.semantic.provider,
              this.semantic.index,
            );
    } else {
      results = searchIndexedFiles(index, options);
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
      const updates = computeDecayUpdates(nodes, accessLog);
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
            memorySignature(
              node.frontMatter.title,
              node.body,
            ) === signature,
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

      if (target !== null) {
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
  async archiveCandidate(
    slug: string,
    sweepId: string,
  ): Promise<string> {
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
  async edit(
    slug: string,
    input: MemoryEditInput,
  ): Promise<ParsedMemoryNode> {
    return this.runSerialized(async () => {
      const node = await this.repository.read(slug);
      if (node === null) {
        throw new MemoryServiceError(`No canonical memory found for "${slug}".`);
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
      body = appendAuditEntry(
        body,
        timestamp,
        input.reason
          ? `memory_edit: ${input.reason}`
          : "memory_edit",
      );

      const updated: ParsedMemoryNode = {
        slug: node.slug,
        frontMatter,
        body,
      };
      await this.repository.write(updated);
      return updated;
    });
  }

  /**
   * Moves exactly one matching canonical node into superseded storage.
   *
   * The recovery record is persisted before the canonical file is removed.
   * Ambiguous substring matches are rejected so a broad request cannot delete
   * multiple memories accidentally.
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

      if (await this.repository.read(target.slug, "superseded")) {
        throw new MemoryServiceError(
          `A superseded memory already exists for "${target.slug}".`,
        );
      }

      const timestamp = this.now().toISOString();
      const recoveryId = randomUUID();
      const originalText = await this.repository.store.readNodeText(target.slug);
      const originalPath = `nodes/${target.slug}.md`;
      const tombstonePath = `nodes/superseded/${target.slug}.md`;
      const recoveryRecord: NodeRecoveryRecord = {
        version: 1,
        id: recoveryId,
        createdAt: timestamp,
        action: "delete-node",
        slug: target.slug,
        originalPath,
        tombstonePath,
        originalText,
      };

      await this.repository.store.writeRecoveryRecord(
        recoveryId,
        `${JSON.stringify(recoveryRecord, null, 2)}\n`,
      );

      const tombstone = cloneNode(target);
      tombstone.frontMatter.status = "superseded";
      tombstone.frontMatter.decay_weight = 0;
      tombstone.frontMatter.edited = timestamp;
      tombstone.body = appendAuditEntry(
        tombstone.body,
        timestamp,
        `memory_delete: moved to superseded; recovery ${recoveryId}`,
      );

      await this.repository.write(tombstone, "superseded");
      try {
        await this.repository.remove(target.slug, "canonical");
      } catch (error) {
        // The canonical file still exists, so remove the duplicate tombstone.
        // The recovery record is harmless and preserves the original payload.
        try {
          await this.repository.remove(target.slug, "superseded");
        } catch {
          throw new MemoryServiceError(
            `Deletion of "${target.slug}" partially failed; both canonical and tombstone files may exist.`,
            { cause: error },
          );
        }
        throw error;
      }

      return {
        recoveryId,
        original: target,
        tombstone,
      };
    });
  }

  /** Restores a deleted node without overwriting a newer canonical node. */
  async restore(recoveryId: string): Promise<MemoryRestorationResult> {
    return this.runSerialized(async () => {
      const record = await this.readRecoveryRecord(recoveryId);
      const canonical = await this.repository.read(record.slug);

      if (record.restoredAt !== undefined) {
        if (canonical === null) {
          throw new MemoryServiceError(
            `Recovery ${recoveryId} is marked restored, but its canonical node is missing.`,
          );
        }
        return {
          recoveryId,
          node: canonical,
          alreadyRestored: true,
        };
      }

      if (canonical !== null) {
        if (canonical.body.includes(`memory_restore: recovery ${recoveryId}`)) {
          await this.removeTombstoneIfPresent(record);
          await this.markRestored(record, canonical.frontMatter.edited ?? this.now().toISOString());
          return {
            recoveryId,
            node: canonical,
            alreadyRestored: true,
          };
        }

        throw new MemoryServiceError(
          `Cannot restore "${record.slug}" because a newer canonical node already exists.`,
        );
      }

      const timestamp = this.now().toISOString();
      const original = parseMemoryNode(
        record.originalText,
        record.slug,
        {
          kind: "node",
          relativePath: record.originalPath,
        },
      );
      const restored = cloneNode(original);
      restored.frontMatter.edited = timestamp;
      restored.body = appendAuditEntry(
        restored.body,
        timestamp,
        `memory_restore: recovery ${recoveryId}`,
      );

      await this.repository.write(restored, "canonical");
      await this.removeTombstoneIfPresent(record);
      await this.markRestored(record, timestamp);

      return {
        recoveryId,
        node: restored,
        alreadyRestored: false,
      };
    });
  }

  /** Serializes state-changing operations that allocate slugs. */
  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Chooses an explicit slug or derives a unique slug from the title. */
  private async allocateSlug(input: MemoryAddInput): Promise<string> {
    const requested = input.slug?.trim();
    if (requested) {
      const slug = validateSlug(requested);
      if (await this.slugExists(slug)) {
        throw new MemoryServiceError(`A memory named "${slug}" already exists.`);
      }
      return slug;
    }

    const base = slugifyTitle(input.title);
    if (!(await this.slugExists(base))) {
      return base;
    }

    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const ending = `-${suffix}`;
      const prefix = base
        .slice(0, 120 - ending.length)
        .replace(/-+$/g, "");
      const candidate = `${prefix}${ending}`;
      if (!(await this.slugExists(candidate))) {
        return candidate;
      }
    }

    throw new MemoryServiceError(`Could not allocate a slug for "${input.title}".`);
  }

  /** Checks all lifecycle areas before considering a slug available. */
  private async slugExists(slug: string): Promise<boolean> {
    for (const area of [
      "canonical",
      "superseded",
      "staging",
    ] satisfies MemoryNodeArea[]) {
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

    const files = await buildMemoryDocumentIndex(this.repository.store);
    await synchronizeVectorIndex(
      files,
      this.semantic.provider,
      this.semantic.index,
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
    );
    const duplicate = results.find(
      (result) =>
        result.kind === "node" &&
        result.status === "active" &&
        result.slug !== undefined &&
        result.slug !== candidate.slug &&
        result.score >= 0.92,
    );
    return duplicate?.slug
      ? this.repository.read(duplicate.slug, "canonical")
      : null;
  }

  /** Reads and validates one recovery record. */
  private async readRecoveryRecord(
    recoveryId: string,
  ): Promise<NodeRecoveryRecord> {
    let source: string | null;
    try {
      source = await this.repository.store.readRecoveryRecord(recoveryId);
    } catch (error) {
      throw new MemoryServiceError(
        `Invalid recovery ID "${recoveryId}".`,
        { cause: error },
      );
    }

    if (source === null) {
      throw new MemoryServiceError(
        `No recovery record found for "${recoveryId}".`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new MemoryServiceError(
        `Recovery ${recoveryId} is not valid JSON.`,
        { cause: error },
      );
    }

    try {
      return parseRecoveryRecord(value, recoveryId);
    } catch (error) {
      if (error instanceof RecoveryRecordError) {
        throw new MemoryServiceError(error.message, { cause: error });
      }
      throw error;
    }
  }

  /** Removes a tombstone when present during restore/idempotency recovery. */
  private async removeTombstoneIfPresent(
    record: NodeRecoveryRecord,
  ): Promise<void> {
    if (await this.repository.read(record.slug, "superseded")) {
      await this.repository.remove(record.slug, "superseded");
    }
  }

  /** Marks a recovery record as completed after the node is restored. */
  private async markRestored(
    record: NodeRecoveryRecord,
    timestamp: string,
  ): Promise<void> {
    const updated: NodeRecoveryRecord = {
      ...record,
      restoredAt: timestamp,
      restoredPath: record.originalPath,
    };
    await this.repository.store.writeRecoveryRecord(
      record.id,
      `${JSON.stringify(updated, null, 2)}\n`,
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
    !merged.body.replace(/\s+/gu, " ").includes(
      candidateBody.replace(/\s+/gu, " "),
    )
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
