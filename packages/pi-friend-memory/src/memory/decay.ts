/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParsedMemoryNode } from "./schema.ts";

/** One decay metadata update derived from volume-relative usage. */
export interface DecayUpdate {
  slug: string;
  useCount: number;
  lastUsed: string;
  decayWeight: number;
}

/** Computes decay changes without modifying node files. */
export function computeDecayUpdates(
  nodes: ParsedMemoryNode[],
  accessLog: string,
): DecayUpdate[] {
  const access = parseAccessLog(accessLog);
  const updates: DecayUpdate[] = [];

  for (const node of nodes) {
    const path = `nodes/${node.slug}.md`;
    const hits = access.filter(
      (entry) =>
        entry.path === path ||
        (entry.path === undefined && entry.slug === node.slug),
    );
    const accessCount = hits.length;
    const latestAccess = hits.at(-1)?.timestamp;
    let lastUsed = node.frontMatter.last_used;
    let decayWeight = node.frontMatter.decay_weight;

    if (
      latestAccess !== undefined &&
      Date.parse(latestAccess) > Date.parse(lastUsed)
    ) {
      lastUsed = latestAccess;
      decayWeight = 1;
    } else if (
      node.frontMatter.status === "superseded" ||
      node.frontMatter.status === "archived"
    ) {
      decayWeight = 0;
    } else {
      const newMemoriesSinceUse = nodes.filter(
        (candidate) =>
          Date.parse(candidate.frontMatter.created) > Date.parse(lastUsed),
      ).length;
      decayWeight = roundWeight(
        Math.max(0.05, 1 / (1 + newMemoriesSinceUse / 10)),
      );
    }

    const useCount = Math.max(node.frontMatter.use_count, accessCount);
    if (
      useCount !== node.frontMatter.use_count ||
      lastUsed !== node.frontMatter.last_used ||
      decayWeight !== node.frontMatter.decay_weight
    ) {
      updates.push({
        slug: node.slug,
        useCount,
        lastUsed,
        decayWeight,
      });
    }
  }

  return updates;
}

interface ParsedAccessEntry {
  timestamp: string;
  slug?: string;
  path?: string;
}

/** Parses valid JSON-lines access records and drops malformed lines. */
function parseAccessLog(source: string): ParsedAccessEntry[] {
  const entries: ParsedAccessEntry[] = [];
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(value) ||
      typeof value.timestamp !== "string" ||
      !Number.isFinite(Date.parse(value.timestamp))
    ) {
      continue;
    }
    entries.push({
      timestamp: value.timestamp,
      ...(typeof value.slug === "string" ? { slug: value.slug } : {}),
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    });
  }
  return entries.sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

/** Rounds decay weights to avoid insignificant file churn. */
function roundWeight(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
