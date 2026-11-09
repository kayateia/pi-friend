/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/** Which end of a retained window one bound supplies. */
export type DateBound = "since" | "until";

/** Raised when a date filter cannot be understood. */
export class MemoryDateFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryDateFilterError";
  }
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * Resolves one date filter value to the instant it denotes.
 *
 * A bare date means a calendar day in the timezone the process runs in — from
 * its first millisecond for `since`, through its last for `until` — so
 * `since: 2026-11-08, until: 2026-11-08` is "today" as the person reading it
 * understands the word, rather than as UTC does. A value that carries a time is
 * taken at exactly that instant.
 *
 * The result is a UTC ISO string because the stored dates are compared as text
 * and only one spelling sorts correctly.
 */
export function resolveDateBound(value: string, bound: DateBound): string {
  const text = value.trim();
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const [, rawYear, rawMonth, rawDay] = dateOnly;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const local =
      bound === "since"
        ? new Date(year, month - 1, day, 0, 0, 0, 0)
        : new Date(year, month - 1, day, 23, 59, 59, 999);
    // `new Date(2026, 1, 31)` is 3 March, so a rolled-over date has to be
    // rejected rather than silently sliding into the next month.
    if (
      local.getFullYear() !== year ||
      local.getMonth() !== month - 1 ||
      local.getDate() !== day
    ) {
      throw new MemoryDateFilterError(
        `${bound} "${value}" is not a real calendar date.`,
      );
    }
    return local.toISOString();
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new MemoryDateFilterError(
      `Could not read ${bound} "${value}": use YYYY-MM-DD, or a timestamp such as 2026-11-08T09:00:00Z.`,
    );
  }
  return new Date(parsed).toISOString();
}

/**
 * Resolves a pair of bounds, rejecting an empty or inverted window.
 *
 * An inverted range is a mistake in the question, and answering it with no
 * results would look like a fact about the store.
 */
export function resolveDateWindow(
  since: string | undefined,
  until: string | undefined,
): { since?: string; until?: string } {
  const resolvedSince =
    since === undefined ? undefined : resolveDateBound(since, "since");
  const resolvedUntil =
    until === undefined ? undefined : resolveDateBound(until, "until");
  if (
    resolvedSince !== undefined &&
    resolvedUntil !== undefined &&
    resolvedSince > resolvedUntil
  ) {
    throw new MemoryDateFilterError(
      `since "${since ?? ""}" is later than until "${until ?? ""}"; the window would be empty.`,
    );
  }
  return {
    ...(resolvedSince === undefined ? {} : { since: resolvedSince }),
    ...(resolvedUntil === undefined ? {} : { until: resolvedUntil }),
  };
}
