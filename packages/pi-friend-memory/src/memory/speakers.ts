/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemorySpeaker } from "./schema.ts";

/** Options for {@link collapseSpeakers}. */
export interface SpeakerCollapseOptions {
  /** The memory being written. A discarded caveat names it so it can be traced. */
  slug?: string;
  /**
   * Called once per person whose uncertainty was dropped, with the line to log.
   *
   * Omitted by callers that only want the collapse, such as the ones holding
   * records already known to be clean.
   */
  reportDiscardedCaveat?: (message: string) => void;
}

/** How one person's records were folded together before the result is built. */
interface SpeakerGroup {
  /** The first spelling seen, which is the one kept. */
  name: string;
  anyConfident: boolean;
  notes: string[];
  /** True when some record was uncertain and said why. */
  uncertainWithNote: boolean;
  /** True when some record was uncertain and said nothing about it. */
  uncertainWithoutNote: boolean;
}

/**
 * Folds repeated records for one person into a single attribution.
 *
 * The invariant this enforces is "one record per person per memory". Two
 * records for one name are not two facts; they are the same person listed
 * twice, and a formatted line that repeats them reads as a contradiction —
 * `Destiny (uncertain); Destiny` says the opposite of itself.
 *
 * Matching is case-insensitive, and the first spelling is kept, because the
 * name a person wrote is theirs and a later copy has no better claim to it.
 *
 * Confidence follows the rule a merge needs rather than the one a single model
 * output needs: **the result is uncertain when any record is uncertain and
 * carries a note**; otherwise it is confident if any record is confident;
 * otherwise it is uncertain. The flag states a doubt and the note states the
 * reason, and only a doubt with a stated reason is worth carrying forward. A
 * bare flag is what a model emits when it hedges, and treating it as binding
 * would let one careless `false` erase a confident attribution everywhere.
 *
 * Because that rule can discard a stated doubt, the caller is told when it
 * does, so the upgrade is visible in the log rather than silent.
 */
export function collapseSpeakers(
  speakers: readonly MemorySpeaker[],
  options: SpeakerCollapseOptions = {},
): MemorySpeaker[] {
  const groups = new Map<string, SpeakerGroup>();

  for (const speaker of speakers) {
    const name = speaker.name.trim();
    if (name === "") {
      continue;
    }
    const note = speaker.note?.trim() ?? "";
    const key = name.toLowerCase();
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        name,
        anyConfident: speaker.confident,
        notes: note === "" ? [] : [note],
        uncertainWithNote: !speaker.confident && note !== "",
        uncertainWithoutNote: !speaker.confident && note === "",
      });
      continue;
    }

    if (speaker.confident) {
      existing.anyConfident = true;
    } else if (note !== "") {
      existing.uncertainWithNote = true;
    } else {
      existing.uncertainWithoutNote = true;
    }
    if (note !== "" && !existing.notes.includes(note)) {
      existing.notes.push(note);
    }
  }

  const collapsed: MemorySpeaker[] = [];
  for (const group of groups.values()) {
    const confident = group.uncertainWithNote
      ? false
      : group.anyConfident;
    if (confident && group.uncertainWithoutNote) {
      options.reportDiscardedCaveat?.(
        `collapsing speaker "${group.name}" in ${
          options.slug === undefined ? "a memory" : `"${options.slug}"`
        }: an uncertain attribution carried no note, so it was kept confident`,
      );
    }
    collapsed.push({
      name: group.name,
      confident,
      ...(group.notes.length === 0 ? {} : { note: group.notes.join("; ") }),
    });
  }
  return collapsed;
}
