/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ParsedMemoryNode } from "./schema.ts";

/*
 * Decay metadata, computed from the store rather than from what was read.
 *
 * Usage — `last_used` and `use_count` — used to be projected here from the
 * access log, which meant a read did not count until the next sweep and the log
 * was the store of record for it. Both now move where the use happens, so this
 * pass has one job: how much a node has aged relative to everything created
 * since it was last touched.
 */

/** One decay change to write back to a node. */
export interface DecayUpdate {
  slug: string;
  decayWeight: number;
}

/** Planned candidate decay and expiration before any files are mutated. */
export interface CandidateDecayPlan {
  updates: DecayUpdate[];
  expiredSlugs: string[];
}

/**
 * Computes decay changes without modifying node files.
 *
 * The clock is the store's own growth: a node ages as memories are created
 * after it was last used. `last_used` is written by the operations that touch a
 * node — a read, a search hit, an injection, an edit, a merge, a promotion — so
 * it is current when this runs, and a node used since the last sweep simply has
 * nothing newer than it to be aged by.
 */
export function computeDecayUpdates(nodes: ParsedMemoryNode[]): DecayUpdate[] {
  const updates: DecayUpdate[] = [];

  for (const node of nodes) {
    const decayWeight =
      node.frontMatter.status === "superseded" ||
      node.frontMatter.status === "archived"
        ? 0
        : volumeDecayWeight(nodes, node.frontMatter.last_used);

    if (decayWeight !== node.frontMatter.decay_weight) {
      updates.push({ slug: node.slug, decayWeight });
    }
  }

  return updates;
}

/**
 * Plans staging decay using canonical additions as the only volume source.
 *
 * A candidate's own `last_used` never moves: candidate access deliberately does
 * not reset decay, so a candidate whatever the retriever happens to like still
 * reaches the floor and is expired. The exception is promotion, which is a use.
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
      volumeDecayWeight(canonicalNodes, candidate.frontMatter.last_used),
    );
    if (decayWeight <= 0.05) {
      expiredSlugs.push(candidate.slug);
    }
    if (decayWeight !== candidate.frontMatter.decay_weight) {
      updates.push({ slug: candidate.slug, decayWeight });
    }
  }

  return { updates, expiredSlugs };
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
