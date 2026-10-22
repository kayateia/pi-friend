/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/** Formats one append-only daily-log entry. */
export function formatDailyEntry(
  timestamp: string,
  sessionId: string,
  content: string,
): string {
  return `<!-- ${timestamp} [${shortSessionId(sessionId)}] -->\n${content.trim()}\n`;
}

/** Returns local calendar dates in newest-first order. */
export function recentDailyDates(now: Date, days: number): string[] {
  const dates: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const value = new Date(now);
    value.setDate(value.getDate() - offset);
    dates.push(localDate(value));
  }
  return dates;
}

/** Returns the trailing portion of a daily log within a character budget. */
export function tailDailyLog(content: string, maxChars: number): string {
  const normalized = content.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `…${normalized.slice(normalized.length - maxChars + 1).trimStart()}`;
}

/** Formats one local calendar date. */
export function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Shortens a session ID for append-only entry markers. */
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
