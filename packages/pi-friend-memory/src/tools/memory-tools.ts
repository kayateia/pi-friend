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
import { ATTRIBUTION_LABEL, formatAttribution } from "../memory/attribution.ts";
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
import { formatRetrievalExplanation } from "../memory/search.ts";
import { DEFAULT_MEMORY_TOOL_PREFIX } from "../memory/config.ts";

const MEMORY_AREAS = [
  "canonical",
  "staging",
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

/** Structured details returned by a deletion. */
interface MemoryDeleteDetails {
  slug: string;
  /** Archived copy, readable by hand and restorable by slug. */
  historyPath: string;
}

/** Structured details returned by a restore. */
interface MemoryRestoreDetails {
  slug: string;
  path: string;
}

/** Structured details returned by promotion of a staging candidate. */
interface MemoryPromoteDetails {
  slug: string;
  merged: boolean;
  mergedInto?: string;
  path: string;
}

/** Structured details returned by a keyword search. */
interface MemorySearchDetails {
  query: string;
  mode: MemorySearchMode;
  count: number;
  results: MemorySearchResult[];
}

/** Prepends the configured namespace to one complete memory tool name. */
export function formatMemoryToolName(
  prefix: string,
  toolName: string,
): string {
  return `${prefix}${toolName}`;
}

/**
 * Registers the first model-facing memory tools against a session-scoped
 * service. Tool execution remains unavailable until storage initialization
 * succeeds.
 */
export function registerMemoryTools(
  pi: ExtensionAPI,
  getService: () => MemoryNodeService | undefined,
  toolPrefix: string = DEFAULT_MEMORY_TOOL_PREFIX,
): void {
  // Tool descriptions refer to each other, so resolve prefixed names once.
  const toolName = (suffix: string): string =>
    formatMemoryToolName(toolPrefix, suffix);

  pi.registerTool({
    name: toolName("memory_add"),
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
    name: toolName("memory_delete"),
    label: "Memory Delete",
    description: [
      "Move one canonical memory node into history without hard-deleting it.",
      "The match may be an exact slug or a case-insensitive substring of its title, tags, or body.",
      "Ambiguous matches are rejected. The node is copied to history/deleted/<slug>.md before it leaves nodes/.",
      `Use ${toolName("memory_restore")} with the slug to undo the deletion, while the history entry is retained.`,
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

      return {
        content: [
          {
            type: "text",
            text:
              `Moved memory "${result.slug}" to ${result.historyPath}.\n` +
              `Use ${toolName("memory_restore")} with the slug to undo the deletion while the history entry is retained.`,
          },
        ],
        details: {
          slug: result.slug,
          historyPath: result.historyPath,
        },
      };
    },
  });

  pi.registerTool({
    name: toolName("memory_restore"),
    label: "Memory Restore",
    description: [
      `Restore a deleted memory node from its entry under history/deleted, by slug.`,
      "Restoration never overwrites a newer canonical node with the same slug.",
      "The history entry is removed once the node is back, so a second restore reports that nothing is left to restore.",
    ].join("\n"),
    parameters: Type.Object({
      slug: Type.String({
        description: `Slug of the deleted memory, as returned by ${toolName("memory_delete")}.`,
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
      const result = await service.restore(params.slug);

      return {
        content: [
          {
            type: "text",
            text: `Restored memory "${result.slug}" from history into nodes/${result.slug}.md.`,
          },
        ],
        details: {
          slug: result.slug,
          path: `nodes/${result.slug}.md`,
        },
      };
    },
  });

  pi.registerTool({
    name: toolName("memory_promote"),
    label: "Memory Promote",
    description: [
      "Promote one auto-captured candidate from staging into canonical memory.",
      "Near-duplicates are merged into an existing active node with links, tags, speakers, and audit history preserved.",
      `Use ${toolName("memory_search")} to find staging candidates when their slug is not already known.`,
    ].join("\n"),
    parameters: Type.Object({
      slug: Type.String({
        description: "Staging candidate slug to promote.",
      }),
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
    ): Promise<AgentToolResult<MemoryPromoteDetails>> {
      const service = requireService(getService);
      const result = await service.promoteCandidate(params.slug);

      return {
        content: [
          {
            type: "text",
            text: result.merged
              ? `Merged staging candidate "${params.slug}" into canonical memory "${result.mergedInto}".`
              : `Promoted staging candidate "${params.slug}" into canonical memory.`,
          },
        ],
        details: {
          slug: result.node.slug,
          merged: result.merged,
          ...(result.mergedInto === undefined
            ? {}
            : { mergedInto: result.mergedInto }),
          path: `nodes/${result.node.slug}.md`,
        },
      };
    },
  });

  pi.registerTool({
    name: toolName("memory_edit"),
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
    name: toolName("memory_read"),
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
    name: toolName("memory_search"),
    label: "Memory Search",
    description: [
      "Search memory and indexed Markdown. The two corpora are different kinds of thing, not two folders.",
      "corpus memory: canonical nodes, which are memories I decided to keep, plus staging candidates, which are unverified proposals that appear in results labelled as candidates. This is the material automatic recall can inject into a prompt.",
      "corpus documents: imported Markdown (notes, journals, workspace files) and ordinary documents in the tree. Searchable, and never injected automatically — context, not memory.",
      "corpus all (default): both, ranked together.",
      "Exact slug and title matches rank above tag and body matches. Semantic mode uses embeddings; hybrid mode fuses keyword and semantic ranks.",
      "Use type to restrict results to one memory-node category; it implies the memory corpus.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description: "Words, slug, title, tag, or phrase to find.",
      }),
      mode: Type.Optional(
        StringEnum(["keyword", "semantic", "hybrid"] as const, {
          description:
            "Search mode. Omitted means memory.search.default_mode (hybrid unless configured otherwise); falls back to keyword with a note when embeddings are unavailable.",
        }),
      ),
      type: Type.Optional(
        StringEnum(MEMORY_TYPES, {
          description:
            "Restrict results to one memory-node type. Implies corpus memory.",
        }),
      ),
      corpus: Type.Optional(
        StringEnum(["all", "memory", "documents"] as const, {
          description:
            "Which part of the index to search. memory: canonical nodes (remembered) and staging candidates (unverified proposals) — what recall can inject. documents: imported and ordinary Markdown — context, never injected. all (default): both.",
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
      const configuredMode = service.store.config.search.defaultMode;
      const requestedMode = params.mode;
      // A call that named a mode gets exactly what it asked for, including the
      // failure. A call that inherited the configured default degrades to
      // keyword when embeddings are unavailable, so a configuration mistake
      // cannot make the tool look broken.
      const degradeDefault =
        requestedMode === undefined &&
        configuredMode !== "keyword" &&
        !service.canSearchSemantically;
      const mode = degradeDefault ? "keyword" : requestedMode;
      if (params.type !== undefined && params.corpus === "documents") {
        throw new Error(
          "type filters memory nodes, so it cannot be combined with corpus \"documents\".",
        );
      }
      const searchOptions: MemorySearchOptions = {
        query: params.query,
        mode,
        type: params.type,
        corpus: params.corpus,
        limit: params.limit,
      };
      const results = await service.search(searchOptions);
      const text = formatSearchResults(params.query, results);
      const note = degradeDefault
        ? `(memory.search.default_mode is "${configuredMode}" but no embedding provider is available; searched with keyword.)\n\n`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `${note}${text}`,
          },
        ],
        details: {
          query: params.query,
          mode: mode ?? configuredMode,
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
      result.modifiedAt === undefined
        ? ""
        : `modified: ${result.modifiedAt}`,
      result.provenance ?? "",
      result.schemaError === undefined ? "" : "schema warning",
    ]
      .filter(Boolean)
      .join(" · ");

    const attribution = formatAttribution(result.speaker);
    return [
      `### ${index + 1}. ${heading}`,
      `Path: ${result.relativePath}`,
      metadata,
      attribution === undefined ? "" : `${ATTRIBUTION_LABEL}: ${attribution}`,
      formatRetrievalExplanation(result),
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
