/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Messages already raised in this process.
 *
 * Banners are the right way to surface a problem that a person should act on,
 * and the wrong way to surface one that repeats: a pass failing every sweep
 * would raise a banner every sweep until someone muted the UI. The file log has
 * its own dedupe; this is the same idea for the visible channel.
 */
const announced = new Set<string>();

/** Reports a message once per key, and never twice. */
export function reportOnce(
  key: string,
  report: ((message: string) => void) | undefined,
  message: string,
): void {
  if (report === undefined || announced.has(key)) {
    return;
  }
  announced.add(key);
  report(message);
}

/** Forgets every announced key; used by tests. */
export function resetReportedMessages(): void {
  announced.clear();
}
