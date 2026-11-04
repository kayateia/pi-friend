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

/** Planned candidate decay and expiration before any files are mutated. */
export interface CandidateDecayPlan {
  updates: DecayUpdate[];
  expiredSlugs: string[];
}

/** Optional diagnostics for malformed access-log records. */
export interface DecayDiagnosticsOptions {
  reportError?: (label: string, error: unknown) => void;
}

/** Computes decay changes without modifying node files. */
export function computeDecayUpdates(
  nodes: ParsedMemoryNode[],
  accessLog: string,
  options: DecayDiagnosticsOptions = {},
): DecayUpdate[] {
  const access = parseAccessLog(accessLog, options.reportError);
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
      decayWeight = volumeDecayWeight(nodes, lastUsed);
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

/**
 * Plans staging decay using canonical additions as the only volume source.
 *
 * Candidate access records intentionally do not reset decay. A candidate at
 * the shared 0.05 floor is expired and returned for removal.
 */
export function planCandidateDecay(
  candidates: ParsedMemoryNode[],
  canonicalNodes: ParsedMemoryNode[],
): CandidateDecayPlan {
  const updates: DecayUpdate[] = [];
  const expiredSlugs: string[] = [];

  for (const candidate of candidates) {
    const decayWeight = Math.min(
      candidate.frontMatter.decay_weight,
      volumeDecayWeight(
        canonicalNodes,
        candidate.frontMatter.last_used,
      ),
    );
    if (decayWeight <= 0.05) {
      expiredSlugs.push(candidate.slug);
    }
    if (decayWeight !== candidate.frontMatter.decay_weight) {
      updates.push({
        slug: candidate.slug,
        useCount: candidate.frontMatter.use_count,
        lastUsed: candidate.frontMatter.last_used,
        decayWeight,
      });
    }
  }

  return { updates, expiredSlugs };
}

interface ParsedAccessEntry {
  timestamp: string;
  slug?: string;
  path?: string;
}

/** Parses valid JSON-lines access records and drops malformed lines. */
function parseAccessLog(
  source: string,
  reportError?: (label: string, error: unknown) => void,
): ParsedAccessEntry[] {
  const entries: ParsedAccessEntry[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      reportError?.(
        "access log parse",
        new Error(`Malformed access-log line ${index + 1}.`, { cause: error }),
      );
      continue;
    }
    if (
      !isRecord(value) ||
      typeof value.timestamp !== "string" ||
      !Number.isFinite(Date.parse(value.timestamp))
    ) {
      reportError?.(
        "access log parse",
        new Error(`Access-log line ${index + 1} has an invalid record shape.`),
      );
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

/** Applies the shared volume curve with the canonical 0.05 floor. */
function volumeDecayWeight(
  canonicalNodes: ParsedMemoryNode[],
  lastUsed: string,
): number {
  const newMemoriesSinceUse = canonicalNodes.filter(
    (candidate) =>
      Date.parse(candidate.frontMatter.created) > Date.parse(lastUsed),
  ).length;
  return roundWeight(
    Math.max(0.05, 1 / (1 + newMemoriesSinceUse / 10)),
  );
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
