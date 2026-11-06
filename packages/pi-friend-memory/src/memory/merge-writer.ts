/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MergeConfig } from "./config.ts";
import type { MemorySpeaker, MemoryType, ParsedMemoryNode } from "./schema.ts";
import { resolveConfiguredModel, runNestedModel } from "./model-call.ts";
import {
  MERGE_SYSTEM_PROMPT,
  resolveSystemPrompt,
  type PromptAdjustment,
} from "./prompts.ts";

const MERGE_TIMEOUT_MS = 30_000;

/**
 * One memory as the merge writer sees it.
 *
 * Deliberately reduced: no tags, links, supersedes or status. The code unions
 * those mechanically, and a writer that cannot see them cannot mangle them. The
 * date is `edited ?? created` so "which account is newer" is answerable without
 * explaining the difference between the two fields.
 */
export interface MergeSource {
  slug: string;
  title: string;
  type: MemoryType;
  speaker: MemorySpeaker[];
  date: string;
  body: string;
}

/** What a merge writer returns. */
export interface MergeRewrite {
  body: string;
  /** Short note naming a contradiction it could not resolve; may be empty. */
  conflict?: string;
}

/**
 * A merge writer, injected into the service.
 *
 * Injected rather than imported so the same implementation serves every way a
 * merge can happen — a sweep verdict, a near-duplicate promotion, and later a
 * manual merge tool — without the service needing a model or a context.
 */
export type MergeWriter = (
  sources: MergeSource[],
  signal?: AbortSignal,
) => Promise<MergeRewrite>;

/** Projects a node into the shape the writer sees. */
export function toMergeSource(node: ParsedMemoryNode): MergeSource {
  return {
    slug: node.slug,
    title: node.frontMatter.title,
    type: node.frontMatter.type,
    speaker: node.frontMatter.speaker.map((entry) => ({ ...entry })),
    date: node.frontMatter.edited ?? node.frontMatter.created,
    body: node.body.trim(),
  };
}

/** Builds the user-side request for one merge. */
export function buildMergePrompt(sources: MergeSource[]): string {
  return [
    'Return {"body":"consolidated memory body","conflict":"short note or empty string"}.',
    "Sources:",
    JSON.stringify(sources, null, 2),
  ].join("\n\n");
}

/**
 * Parses a merge response.
 *
 * Throws on anything that is not a usable body; the caller falls back to a
 * mechanical append rather than writing an empty memory.
 */
export function parseMergeResponse(response: string): MergeRewrite {
  const object = extractJsonObject(response);
  if (!object) {
    throw new Error("Merge response must contain a JSON object.");
  }
  const body = typeof object.body === "string" ? object.body.trim() : "";
  if (body === "") {
    throw new Error("Merge response must contain a non-empty body.");
  }
  const conflict =
    typeof object.conflict === "string" ? object.conflict.trim() : "";
  return {
    body,
    ...(conflict === "" ? {} : { conflict }),
  };
}

/** Builds a merge writer backed by the configured or session model. */
export function createMergeWriter(
  ctx: ExtensionContext,
  config: MergeConfig,
  reportWarning: (message: string) => void,
): MergeWriter {
  return async (sources, signal) => {
    const model = resolveConfiguredModel(
      ctx,
      config.model,
      "memory.merge.model",
      reportWarning,
    );
    if (!model) {
      throw new Error("No model is available for merging.");
    }

    const response = await runNestedModel(ctx, model, {
      systemPrompt: resolveSystemPrompt(
        MERGE_SYSTEM_PROMPT,
        config as PromptAdjustment,
      ),
      userContent: buildMergePrompt(sources),
      maxTokens: 4_000,
      timeoutMs: MERGE_TIMEOUT_MS,
      label: "merge",
      reportWarning,
      ...(signal === undefined ? {} : { signal }),
      ...(config.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: config.thinkingLevel }),
    });
    return parseMergeResponse(response);
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
