/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  MEMORY_TYPES,
  serializeMemoryNode,
} from "../memory/schema.ts";
import type {
  MemoryStatus,
  MemoryType,
} from "../memory/schema.ts";
import type { MemoryNodeArea } from "../memory/repository.ts";
import type {
  MemoryAddInput,
  MemoryEditInput,
  MemoryNodeService,
} from "../memory/service.ts";
import type {
  MemorySearchOptions,
  MemorySearchResult,
  MemorySearchMode,
} from "../memory/search.ts";

const MEMORY_AREAS = [
  "canonical",
  "staging",
  "superseded",
] as const satisfies readonly MemoryNodeArea[];

/** Structured details shared by successful and failed memory reads. */
interface MemoryReadDetails {
  slug: string;
  area: MemoryNodeArea;
  type?: MemoryType;
  status?: MemoryStatus;
}

/** Structured details returned by a successful memory addition. */
interface MemoryAddDetails {
  slug: string;
  path: string;
  type: MemoryType;
  status: MemoryStatus;
}

/** Structured details returned by a successful memory edit. */
interface MemoryEditDetails extends MemoryAddDetails {
  edited: string;
}

/** Structured details returned by a recoverable deletion. */
interface MemoryDeleteDetails {
  slug: string;
  recoveryId: string;
  canonicalPath: string;
  tombstonePath: string;
}

/** Structured details returned by a recovery operation. */
interface MemoryRestoreDetails {
  slug: string;
  recoveryId: string;
  alreadyRestored: boolean;
}

/** Structured details returned by a keyword search. */
interface MemorySearchDetails {
  query: string;
  mode: MemorySearchMode;
  count: number;
  results: MemorySearchResult[];
}

/**
 * Registers the first model-facing memory tools against a session-scoped
 * service. Tool execution remains unavailable until storage initialization
 * succeeds.
 */
export function registerMemoryTools(
  pi: ExtensionAPI,
  getService: () => MemoryNodeService | undefined,
): void {
  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description: [
      "Create one canonical memory node about a single topic.",
      "Use this when someone asks you to remember something or when a durable preference, fact, event, or relational detail should persist.",
      "Provide speaker attribution for the actual person or system who supplied the information.",
      "The slug is derived from the title unless an explicit slug is supplied.",
    ].join("\n"),
    parameters: Type.Object({
      title: Type.String({
        description: "Short human-readable title for this single memory.",
      }),
      body: Type.String({
        description: "Concise Markdown body containing the memory.",
      }),
      type: StringEnum(MEMORY_TYPES, {
        description: "Semantic category for the memory.",
      }),
      speaker: Type.Array(
        Type.Object({
          name: Type.String({
            description: "Actual person or system member who supplied it.",
          }),
          confident: Type.Boolean({
            description: "False when attribution was inferred or uncertain.",
          }),
          note: Type.Optional(
            Type.String({
              description: "Optional attribution context.",
            }),
          ),
        }),
        {
          description: "Speaker attribution records, ordered by confidence.",
        },
      ),
      slug: Type.Optional(
        Type.String({
          description: "Optional explicit lowercase hyphenated slug.",
        }),
      ),
      agents: Type.Optional(
        Type.Array(Type.String(), {
          description: "AI agents involved in creating or relaying the memory.",
        }),
      ),
      emotional_flavor: Type.Optional(
        Type.String({
          description: "Free-form emotional tone, such as warm or sore.",
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Searchable keywords.",
        }),
      ),
      links: Type.Optional(
        Type.Array(Type.String(), {
          description: "Slugs of related memory nodes.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: "Optional source pointer to a log or conversation.",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<MemoryAddDetails>> {
      const service = requireService(getService);
      const input: MemoryAddInput = {
        title: params.title,
        type: params.type,
        body: params.body,
        speaker: params.speaker,
        slug: params.slug,
        agents: params.agents,
        emotionalFlavor: params.emotional_flavor,
        tags: params.tags,
        links: params.links,
        source: params.source,
      };
      const node = await service.add(input);
      const relativePath = `nodes/${node.slug}.md`;

      return {
        content: [
          {
            type: "text",
            text:
              `Created memory "${node.slug}" (${node.frontMatter.type}).\n` +
              `Path: ${relativePath}\n` +
              `Title: ${node.frontMatter.title}`,
          },
        ],
        details: {
          slug: node.slug,
          path: relativePath,
          type: node.frontMatter.type,
          status: node.frontMatter.status,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: [
      "Move one canonical memory node into superseded storage without hard-deleting it.",
      "The match may be an exact slug or a case-insensitive substring of its title, tags, or body.",
      "Ambiguous matches are rejected. A durable recovery record is written before the node moves.",
      "Use memory_restore with the returned recovery ID to undo the deletion.",
    ].join("\n"),
    parameters: Type.Object({
      match: Type.String({
        description: "Exact slug or uniquely identifying substring.",
      }),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<MemoryDeleteDetails>> {
      const service = requireService(getService);
      const result = await service.delete(params.match);
      const canonicalPath = `nodes/${result.original.slug}.md`;
      const tombstonePath = `nodes/superseded/${result.tombstone.slug}.md`;

      return {
        content: [
          {
            type: "text",
            text:
              `Moved memory "${result.original.slug}" to superseded storage.\n` +
              `Recovery ID: ${result.recoveryId}\n` +
              `Use memory_restore with this ID to undo the deletion.`,
          },
        ],
        details: {
          slug: result.original.slug,
          recoveryId: result.recoveryId,
          canonicalPath,
          tombstonePath,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_restore",
    label: "Memory Restore",
    description: [
      "Restore a deleted memory node using the recovery ID returned by memory_delete.",
      "Restoration never overwrites a newer canonical node.",
      "Repeated restoration is idempotent.",
    ].join("\n"),
    parameters: Type.Object({
      recoveryId: Type.String({
        description: "UUID recovery ID returned by memory_delete.",
      }),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<MemoryRestoreDetails>> {
      const service = requireService(getService);
      const result = await service.restore(params.recoveryId);

      return {
        content: [
          {
            type: "text",
            text: result.alreadyRestored
              ? `Memory "${result.node.slug}" was already restored from recovery ${result.recoveryId}.`
              : `Restored memory "${result.node.slug}" from recovery ${result.recoveryId}.`,
          },
        ],
        details: {
          slug: result.node.slug,
          recoveryId: result.recoveryId,
          alreadyRestored: result.alreadyRestored,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_edit",
    label: "Memory Edit",
    description: [
      "Edit one canonical memory node by slug.",
      "Preserves creation, usage, and decay metadata, sets an edited timestamp, and appends an audit entry.",
      "Supply only the fields that should change; body replaces the existing body before the audit line is appended.",
    ].join("\n"),
    parameters: Type.Object({
      slug: Type.String({
        description: "Canonical memory slug to edit.",
      }),
      title: Type.Optional(
        Type.String({
          description: "Replacement short title.",
        }),
      ),
      type: Type.Optional(
        StringEnum(MEMORY_TYPES, {
          description: "Replacement semantic category.",
        }),
      ),
      body: Type.Optional(
        Type.String({
          description: "Replacement Markdown body, excluding the audit line.",
        }),
      ),
      speaker: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({
              description: "Actual person or system member who supplied it.",
            }),
            confident: Type.Boolean({
              description: "False when attribution was inferred.",
            }),
            note: Type.Optional(Type.String()),
          }),
        ),
      ),
      agents: Type.Optional(Type.Array(Type.String())),
      emotional_flavor: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      links: Type.Optional(Type.Array(Type.String())),
      source: Type.Optional(Type.String()),
      reason: Type.Optional(
        Type.String({
          description: "Short reason recorded in the audit trail.",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<MemoryEditDetails>> {
      const service = requireService(getService);
      const input: MemoryEditInput = {
        title: params.title,
        type: params.type,
        body: params.body,
        speaker: params.speaker,
        agents: params.agents,
        emotionalFlavor: params.emotional_flavor,
        tags: params.tags,
        links: params.links,
        source: params.source,
        reason: params.reason,
      };
      const node = await service.edit(params.slug, input);
      const relativePath = `nodes/${node.slug}.md`;
      const edited = node.frontMatter.edited ?? "";

      return {
        content: [
          {
            type: "text",
            text: `Updated memory "${node.slug}" at ${edited}.\nPath: ${relativePath}`,
          },
        ],
        details: {
          slug: node.slug,
          path: relativePath,
          type: node.frontMatter.type,
          status: node.frontMatter.status,
          edited,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: [
      "Read one memory node by slug.",
      "Canonical nodes are read by default; staging or superseded can be requested explicitly.",
      "Returns the complete serialized Markdown node with front matter and body.",
    ].join("\n"),
    parameters: Type.Object({
      slug: Type.String({
        description: "Lowercase hyphenated memory slug.",
      }),
      area: Type.Optional(
        StringEnum(MEMORY_AREAS, {
          description: "Node lifecycle area. Default: canonical.",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<MemoryReadDetails>> {
      const service = requireService(getService);
      const area = params.area ?? "canonical";
      const node = await service.read(params.slug, area);
      if (node === null) {
        return {
          content: [
            {
              type: "text",
              text: `No ${area} memory found for "${params.slug}".`,
            },
          ],
          isError: true,
          details: {
            slug: params.slug,
            area,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: serializeMemoryNode(node),
          },
        ],
        details: {
          slug: node.slug,
          area,
          type: node.frontMatter.type,
          status: node.frontMatter.status,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: [
      "Search every Markdown file in the memory tree using deterministic keyword ranking.",
      "Results distinguish memory nodes, staging candidates, and ordinary documents.",
      "Exact slug and title matches rank above tag and body matches.",
      "Semantic mode uses embeddings; hybrid mode fuses keyword and semantic ranks.",
      "Use the optional type filter to restrict results to one memory-node category.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description: "Words, slug, title, tag, or phrase to find.",
      }),
      mode: Type.Optional(
        StringEnum(["keyword", "semantic", "hybrid"] as const, {
          description: "Search mode. Default: keyword.",
        }),
      ),
      type: Type.Optional(
        StringEnum(MEMORY_TYPES, {
          description: "Restrict results to one memory-node type.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum results, from 1 to 25. Default: 5.",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<MemorySearchDetails>> {
      const service = requireService(getService);
      const mode = params.mode ?? "keyword";
      const searchOptions: MemorySearchOptions = {
        query: params.query,
        mode,
        type: params.type,
        limit: params.limit,
      };
      const results = await service.search(searchOptions);

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(params.query, results),
          },
        ],
        details: {
          query: params.query,
          mode,
          count: results.length,
          results,
        },
      };
    },
  });
}

/** Formats ranked search results for the model-facing tool response. */
function formatSearchResults(
  query: string,
  results: MemorySearchResult[],
): string {
  if (results.length === 0) {
    return `No memories found for "${query}".`;
  }

  const blocks = results.map((result, index) => {
    const heading =
      result.title ??
      result.slug ??
      result.relativePath;
    const metadata = [
      `kind: ${result.kind}`,
      result.type === undefined ? "" : `type: ${result.type}`,
      result.status === undefined ? "" : `status: ${result.status}`,
      result.schemaError === undefined ? "" : "schema warning",
    ]
      .filter(Boolean)
      .join(" · ");

    return [
      `### ${index + 1}. ${heading}`,
      `Path: ${result.relativePath}`,
      metadata,
      result.snippet,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}".\n\n${blocks.join("\n\n---\n\n")}`;
}

/** Resolves the service or reports that storage initialization failed. */
function requireService(
  getService: () => MemoryNodeService | undefined,
): MemoryNodeService {
  const service = getService();
  if (!service) {
    throw new Error(
      "pi-friend memory storage is unavailable; check the initialization error.",
    );
  }
  return service;
}
