/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryConfigOptions } from "./config.ts";
import type { ParsedMemoryNode } from "./schema.ts";
import {
  parseMemoryNodeFile,
  serializeMemoryNode,
  validateMemoryNodeLocation,
} from "./schema.ts";
import type { MemoryFileKind } from "./paths.ts";
import { validateSlug } from "./paths.ts";
import { MemoryStore } from "./store.ts";

/** Node areas that have different lifecycle and location rules. */
export type MemoryNodeArea = "canonical" | "superseded" | "staging";

/** One resolved node location. */
interface NodeLocation {
  kind: MemoryFileKind;
  relativePath: string;
}

/**
 * Storage-aware repository for complete, validated memory nodes.
 *
 * Callers work with ParsedMemoryNode values; path selection, schema
 * validation, serialization, and atomic writes stay behind this boundary.
 */
export class MemoryNodeRepository {
  readonly store: MemoryStore;

  /** Opens a repository using the standard configuration and layout flow. */
  static async open(
    options: MemoryConfigOptions = {},
  ): Promise<MemoryNodeRepository> {
    return new MemoryNodeRepository(await MemoryStore.open(options));
  }

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /** Reads one node, returning null when that area has no matching file. */
  async read(
    slug: string,
    area: MemoryNodeArea = "canonical",
  ): Promise<ParsedMemoryNode | null> {
    const location = nodeLocation(slug, area);
    const text = await this.store.readTextFileIfExists(location.relativePath);
    if (text === null) {
      return null;
    }

    return parseMemoryNodeFile(text, location);
  }

  /**
   * Validates and atomically writes one node into its lifecycle area.
   *
   * Moving a node between areas remains a separate operation so callers can
   * add the required recovery records and sweep logs.
   */
  async write(
    node: ParsedMemoryNode,
    area: MemoryNodeArea = "canonical",
  ): Promise<void> {
    const location = nodeLocation(node.slug, area);
    validateMemoryNodeLocation(node, location);
    await this.store.writeTextFile(
      location.relativePath,
      serializeMemoryNode(node),
    );
  }

  /** Removes one node from a lifecycle area. */
  async remove(
    slug: string,
    area: MemoryNodeArea = "canonical",
  ): Promise<void> {
    const location = nodeLocation(slug, area);
    await this.store.removeTextFile(location.relativePath);
  }

  /** Reads and validates every node in one lifecycle area. */
  async list(area: MemoryNodeArea = "canonical"): Promise<ParsedMemoryNode[]> {
    const files = (await this.store.listMarkdownFiles()).filter((file) =>
      belongsToArea(file.relativePath, area),
    );

    const nodes = await Promise.all(
      files.map(async (file) => {
        const text = await this.store.readTextFile(file.relativePath);
        return parseMemoryNodeFile(text, {
          kind: file.kind,
          relativePath: file.relativePath,
        });
      }),
    );

    return nodes.sort((left, right) => {
      if (left.slug < right.slug) {
        return -1;
      }
      if (left.slug > right.slug) {
        return 1;
      }
      return 0;
    });
  }
}

/** Resolves a validated slug and lifecycle area to a storage location. */
function nodeLocation(slug: string, area: MemoryNodeArea): NodeLocation {
  const validSlug = validateSlug(slug);
  switch (area) {
    case "canonical":
      return {
        kind: "node",
        relativePath: `nodes/${validSlug}.md`,
      };
    case "superseded":
      return {
        kind: "node",
        relativePath: `nodes/superseded/${validSlug}.md`,
      };
    case "staging":
      return {
        kind: "staging-candidate",
        relativePath: `staging/${validSlug}.md`,
      };
  }
}

/** Returns whether a stored relative path belongs to one node area. */
function belongsToArea(
  relativePath: string,
  area: MemoryNodeArea,
): boolean {
  switch (area) {
    case "canonical":
      return (
        relativePath.startsWith("nodes/") &&
        !relativePath.startsWith("nodes/superseded/")
      );
    case "superseded":
      return relativePath.startsWith("nodes/superseded/");
    case "staging":
      return relativePath.startsWith("staging/");
  }
}
