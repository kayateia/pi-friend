/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MemorySpeaker,
  MemoryType,
  ParsedMemoryNode,
} from "./schema.ts";
import { validateSlug } from "./paths.ts";
import { appendAuditEntry } from "./audit.ts";
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
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    repository: MemoryNodeRepository,
    now: () => Date = () => new Date(),
  ) {
    this.repository = repository;
    this.now = now;
  }

  /** Reads a node from one lifecycle area. */
  async read(
    slug: string,
    area: MemoryNodeArea = "canonical",
  ): Promise<ParsedMemoryNode | null> {
    return this.repository.read(slug, area);
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
