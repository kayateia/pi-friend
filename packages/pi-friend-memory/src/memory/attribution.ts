/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemorySpeaker } from "./schema.ts";

/** Label used everywhere attribution is shown, so the surfaces agree. */
export const ATTRIBUTION_LABEL = "Heard from";

/**
 * Formats speaker records as one short line of prose.
 *
 * Attribution is content in a plural system, so it belongs next to the memory
 * rather than behind a second tool call — but it must not dominate. Names are
 * joined with `;` because a note may contain commas, `confident: false` is
 * marked as uncertain, and a note is shortened rather than allowed to push the
 * excerpt out of its budget.
 */
export function formatAttribution(
  speakers: readonly MemorySpeaker[] | undefined,
  maxNoteChars = 60,
): string | undefined {
  const parts: string[] = [];
  for (const speaker of speakers ?? []) {
    const name = speaker.name.trim();
    if (name === "") {
      continue;
    }
    const uncertainty = speaker.confident ? "" : " (uncertain)";
    const note = speaker.note?.trim() ?? "";
    const shown =
      note === ""
        ? ""
        : ` — ${note.length > maxNoteChars ? `${note.slice(0, maxNoteChars - 1).trimEnd()}…` : note}`;
    parts.push(`${name}${uncertainty}${shown}`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}
