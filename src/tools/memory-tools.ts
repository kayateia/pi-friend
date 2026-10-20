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
  MemoryNodeService,
} from "../memory/service.ts";

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
