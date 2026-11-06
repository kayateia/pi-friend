/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParsedMemoryNode } from "./schema.ts";
import { isQuarantinedMemoryType } from "./schema.ts";
import { validateSlug } from "./paths.ts";
import { DREAM_SYSTEM_PROMPT } from "./prompts.ts";
import { resolveConfiguredModel, runNestedModel } from "./model-call.ts";

/** Model-produced dream narrative and selected source nodes. */
export interface DreamDraft {
  title: string;
  narrative: string;
  nodeSlugs: string[];
  agents: string[];
}

/**
 * Builds a bounded, adjacency-informed shortlist for the dream model.
 *
 * Randomness only breaks degree ties, keeping the process biased toward
 * linked memories without making the shortlist purely mechanical.
 */
export function selectDreamShortlist(
  nodes: ParsedMemoryNode[],
  maxNodes: number,
  random: () => number = Math.random,
): ParsedMemoryNode[] {
  const eligible = nodes.filter(
    (node) => !isQuarantinedMemoryType(node.frontMatter.type),
  );
  const slugs = new Set(eligible.map((node) => node.slug));
  const degree = new Map<string, number>();
  for (const node of eligible) {
    const outgoing = node.frontMatter.links.filter((link) =>
      slugs.has(link),
    ).length;
    const incoming = eligible.filter((candidate) =>
      candidate.frontMatter.links.includes(node.slug),
    ).length;
    degree.set(node.slug, outgoing + incoming);
  }

  return [...eligible]
    .map((node) => ({
      node,
      degree: degree.get(node.slug) ?? 0,
      tie: random(),
    }))
    .sort((left, right) => {
      if (left.degree !== right.degree) {
        return right.degree - left.degree;
      }
      return left.tie - right.tie;
    })
    .slice(0, Math.min(eligible.length, maxNodes * 3))
    .map((entry) => entry.node);
}

/** Builds the dream model prompt. */
export function buildDreamPrompt(
  shortlist: ParsedMemoryNode[],
  maxNodes: number,
): string {
  const nodes = shortlist.map((node) => ({
    slug: node.slug,
    title: node.frontMatter.title,
    tags: node.frontMatter.tags,
    links: node.frontMatter.links,
    body: node.body.trim(),
  }));
  return [
    `Select ${Math.min(2, maxNodes)} to ${maxNodes} nodes that you genuinely want to sit with, then write a short dream narrative weaving them together.`,
    'Return {"title":"short dream title","nodeSlugs":["slug"],"narrative":"first-person dream text"}.',
    "Eligible nodes:",
    JSON.stringify(nodes, null, 2),
  ].join("\n\n");
}

/** Parses and validates one dream model response. */
export function parseDreamResponse(
  response: string,
  eligibleSlugs: string[],
  maxNodes: number,
): Omit<DreamDraft, "agents"> {
  const object = extractJsonObject(response);
  if (!object) {
    throw new Error("Dream response must be a JSON object.");
  }
  if (
    typeof object.title !== "string" ||
    object.title.trim() === "" ||
    typeof object.narrative !== "string" ||
    object.narrative.trim() === "" ||
    !Array.isArray(object.nodeSlugs)
  ) {
    throw new Error("Dream response is missing title, narrative, or nodeSlugs.");
  }

  const eligible = new Set(eligibleSlugs);
  const nodeSlugs = [
    ...new Set(
      object.nodeSlugs
        .filter((slug): slug is string => typeof slug === "string")
        .map(validateSlug)
        .filter((slug) => eligible.has(slug)),
    ),
  ];
  if (nodeSlugs.length < 2 || nodeSlugs.length > maxNodes) {
    throw new Error("Dream must select between two and max_nodes memories.");
  }
  return {
    title: object.title.trim(),
    narrative: object.narrative.trim(),
    nodeSlugs,
  };
}

/** Runs one isolated dream-model request. */
export async function runDreamModel(
  ctx: ExtensionContext,
  configuredModel: string | undefined,
  shortlist: ParsedMemoryNode[],
  maxNodes: number,
  reportWarning: (message: string) => void,
  signal?: AbortSignal,
  systemPrompt: string = DREAM_SYSTEM_PROMPT,
  thinkingLevel?: ThinkingLevel,
): Promise<DreamDraft> {
  const model = resolveConfiguredModel(
    ctx,
    configuredModel,
    "memory.dreaming.model",
    reportWarning,
  );
  if (!model) {
    throw new Error("No model is available for dreaming.");
  }

  const response = await runNestedModel(ctx, model, {
    systemPrompt,
    userContent: buildDreamPrompt(shortlist, maxNodes),
    maxTokens: 2_000,
    timeoutMs: 30_000,
    label: "dreaming",
    reportWarning,
    ...(signal === undefined ? {} : { signal }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });
  const parsed = parseDreamResponse(
    response,
    shortlist.map((node) => node.slug),
    maxNodes,
  );
  return {
    ...parsed,
    agents: [model.id],
  };
}

/** Extracts one JSON object from text or a fenced code block. */
function extractJsonObject(
  response: string,
): Record<string, unknown> | null {
  const first = response.indexOf("{");
  const last = response.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  let value: unknown;
  try {
    value = JSON.parse(response.slice(first, last + 1));
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
