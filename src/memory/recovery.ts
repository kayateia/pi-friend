/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateSlug } from "./paths.ts";

/** Versioned recovery payload for a deleted memory node. */
export interface NodeRecoveryRecord {
  version: 1;
  id: string;
  createdAt: string;
  action: "delete-node";
  slug: string;
  originalPath: string;
  tombstonePath: string;
  originalText: string;
  restoredAt?: string;
  restoredPath?: string;
}

/** Error raised when a recovery record is malformed or inconsistent. */
export class RecoveryRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryRecordError";
  }
}

const RECOVERY_KEYS = new Set([
  "version",
  "id",
  "createdAt",
  "action",
  "slug",
  "originalPath",
  "tombstonePath",
  "originalText",
  "restoredAt",
  "restoredPath",
]);

/** Parses and validates one JSON recovery record. */
export function parseRecoveryRecord(
  value: unknown,
  expectedId: string,
): NodeRecoveryRecord {
  if (!isRecord(value)) {
    throw new RecoveryRecordError("Recovery record must be a JSON object.");
  }

  for (const key of Object.keys(value)) {
    if (!RECOVERY_KEYS.has(key)) {
      throw new RecoveryRecordError(`Unknown recovery field "${key}".`);
    }
  }

  if (value.version !== 1) {
    throw new RecoveryRecordError("Unsupported recovery record version.");
  }
  if (value.id !== expectedId || typeof value.id !== "string") {
    throw new RecoveryRecordError("Recovery ID does not match its filename.");
  }
  if (!isTimestamp(value.createdAt)) {
    throw new RecoveryRecordError("Recovery createdAt is invalid.");
  }
  if (value.action !== "delete-node") {
    throw new RecoveryRecordError("Unsupported recovery action.");
  }
  if (typeof value.slug !== "string") {
    throw new RecoveryRecordError("Recovery slug is invalid.");
  }

  const slug = validateSlug(value.slug);
  const originalPath = `nodes/${slug}.md`;
  const tombstonePath = `nodes/superseded/${slug}.md`;
  if (value.originalPath !== originalPath) {
    throw new RecoveryRecordError("Recovery originalPath is inconsistent.");
  }
  if (value.tombstonePath !== tombstonePath) {
    throw new RecoveryRecordError("Recovery tombstonePath is inconsistent.");
  }
  if (typeof value.originalText !== "string" || value.originalText.trim() === "") {
    throw new RecoveryRecordError("Recovery originalText must not be empty.");
  }
  if (value.restoredAt !== undefined && !isTimestamp(value.restoredAt)) {
    throw new RecoveryRecordError("Recovery restoredAt is invalid.");
  }
  if (
    value.restoredPath !== undefined &&
    value.restoredPath !== originalPath
  ) {
    throw new RecoveryRecordError("Recovery restoredPath is inconsistent.");
  }

  return {
    version: 1,
    id: expectedId,
    createdAt: value.createdAt,
    action: "delete-node",
    slug,
    originalPath,
    tombstonePath,
    originalText: value.originalText,
    ...(value.restoredAt === undefined ? {} : { restoredAt: value.restoredAt }),
    ...(value.restoredPath === undefined
      ? {}
      : { restoredPath: value.restoredPath }),
  };
}

/** Returns a valid timestamp string, or false for malformed values. */
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  );
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
