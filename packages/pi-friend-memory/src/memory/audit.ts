/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Appends a dated audit entry to a node body.
 *
 * Existing prose and any pre-existing audit entries are retained. The audit
 * section is created only when it does not already exist.
 */
export function appendAuditEntry(
  body: string,
  timestamp: string,
  message: string,
): string {
  const normalizedBody = body.replace(/\s+$/u, "");
  const normalizedMessage = message.trim().replace(/\s+/gu, " ");
  const entry = `- ${timestamp} — ${normalizedMessage || "memory_edit"}`;

  if (/^## audit[ \t]*$/imu.test(normalizedBody)) {
    return `${normalizedBody}\n${entry}\n`;
  }

  return `${normalizedBody}\n\n## audit\n\n${entry}\n`;
}
