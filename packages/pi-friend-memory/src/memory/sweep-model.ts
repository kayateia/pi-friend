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
import { validateSlug } from "./paths.ts";
import { SWEEP_SYSTEM_PROMPT } from "./prompts.ts";
import { readModelJson } from "./model-json.ts";
import { resolveConfiguredModel, runNestedModel } from "./model-call.ts";

/** One action a sweep decision may request. `drop` needs `allow_drop`. */
export type SweepAction = "promote" | "merge" | "drop";

/**
 * Response budget for one sweep request.
 *
 * The prompt asks for one decision per candidate and does not cap how many
 * candidates it sends, so the budget has to fit the largest realistic batch: a
 * decision with its reason runs 30-50 tokens, and a store with 200 staged
 * candidates needs far more than the 3,000 this used to allow. The previous
 * value truncated the JSON mid-array on a 70-candidate queue, which reaches
 * `parseSweepResponse` as "must contain a decisions array" and fails the whole
 * run. A model that stops early for quality reasons costs nothing here; a model
 * cut off mid-object costs the entire sweep.
 */
export const SWEEP_MAX_TOKENS = 15_000;

/** One model judgment for a staging candidate. */
export interface SweepDecision {
  slug: string;
  action: SweepAction;
  target?: string;
  reason: string;
}

/** Builds the sweep model request. */
export function buildSweepPrompt(
  candidates: ParsedMemoryNode[],
  canonical: ParsedMemoryNode[],
  allowDrop = false,
): string {
  const candidateData = candidates.map((node) => ({
    slug: node.slug,
    title: node.frontMatter.title,
    type: node.frontMatter.type,
    speaker: node.frontMatter.speaker,
    tags: node.frontMatter.tags,
    body: node.body.trim(),
  }));
  const canonicalData = canonical.slice(0, 50).map((node) => ({
    slug: node.slug,
    title: node.frontMatter.title,
    type: node.frontMatter.type,
    tags: node.frontMatter.tags,
    body: node.body.trim().slice(0, 600),
  }));

  return [
    allowDrop
      ? 'Return {"decisions":[{"slug":"candidate-slug","action":"promote|merge|drop","target":"existing-slug or omitted","reason":"brief rationale"}]}.'
      : 'Return {"decisions":[{"slug":"candidate-slug","action":"promote|merge","target":"existing-slug or omitted","reason":"brief rationale"}]}.',
    "Candidates:",
    JSON.stringify(candidateData, null, 2),
    "Existing canonical memories:",
    JSON.stringify(canonicalData, null, 2),
  ].join("\n\n");
}

/**
 * Parses and validates sweep decisions.
 *
 * `allowDrop` follows the configuration: with it off, a `drop` decision is left
 * on the floor exactly like any other unknown action, because the sweep model
 * was never offered the vocabulary.
 */
export function parseSweepResponse(
  response: string,
  candidateSlugs: string[],
  canonicalSlugs: string[],
  allowDrop = false,
  reportWarning?: (message: string) => void,
): SweepDecision[] {
  const reading = readModelJson(response, reportWarning);
  const object = reading.object;
  if (!object) {
    throw new Error(
      `Sweep response ${reading.problem ?? "must contain a decisions array"}.`,
    );
  }
  if (!Array.isArray(object.decisions)) {
    throw new Error("Sweep response must contain a decisions array.");
  }

  const candidateSet = new Set(candidateSlugs);
  const canonicalSet = new Set(canonicalSlugs);
  const seen = new Set<string>();
  const decisions: SweepDecision[] = [];
  for (const value of object.decisions) {
    if (!isRecord(value)) continue;
    if (
      typeof value.slug !== "string" ||
      !candidateSet.has(value.slug) ||
      seen.has(value.slug)
    ) {
      continue;
    }
    if (
      value.action !== "promote" &&
      value.action !== "merge" &&
      !(allowDrop && value.action === "drop")
    ) {
      continue;
    }
    if (typeof value.reason !== "string" || value.reason.trim() === "") {
      continue;
    }
    const target =
      typeof value.target === "string" ? value.target : undefined;
    if (
      value.action === "merge" &&
      (target === undefined || !canonicalSet.has(target))
    ) {
      continue;
    }

    seen.add(value.slug);
    decisions.push({
      slug: value.slug,
      action: value.action,
      ...(value.action === "merge" && target !== undefined
        ? { target: validateSlug(target) }
        : {}),
      reason: value.reason.trim(),
    });
  }
  return decisions;
}

/** Runs one isolated sweep-model request. */
export async function runSweepModel(
  ctx: ExtensionContext,
  configuredModel: string | undefined,
  candidates: ParsedMemoryNode[],
  canonical: ParsedMemoryNode[],
  reportWarning: (message: string) => void,
  signal?: AbortSignal,
  systemPrompt: string = SWEEP_SYSTEM_PROMPT,
  allowDrop = false,
  thinkingLevel?: ThinkingLevel,
): Promise<SweepDecision[]> {
  const model = resolveConfiguredModel(
    ctx,
    configuredModel,
    "memory.sweep.model",
    reportWarning,
  );
  if (!model) {
    throw new Error("No model is available for sweep decisions.");
  }

  const response = await runNestedModel(ctx, model, {
    systemPrompt,
    userContent: buildSweepPrompt(candidates, canonical, allowDrop),
    maxTokens: SWEEP_MAX_TOKENS,
    timeoutMs: 30_000,
    label: "sweep",
    reportWarning,
    ...(signal === undefined ? {} : { signal }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });
  return parseSweepResponse(
    response,
    candidates.map((node) => node.slug),
    canonical.map((node) => node.slug),
    allowDrop,
    reportWarning,
  );
}


/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
