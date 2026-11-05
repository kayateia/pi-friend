/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** File name of the persisted capture cursors beside the extension config. */
export const CAPTURE_STATE_FILENAME = "capture-state.json";

/** Current on-disk shape. Version 1 held a single session's cursor. */
export const CAPTURE_STATE_VERSION = 2;

/** Cursors older than this are pruned on write. */
export const CAPTURE_STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * Where auto-capture had read to in one session.
 *
 * `lastEntryId` is a Pi transcript entry id, not a byte offset: Pi's session
 * format owns that identity and the extension only remembers it. Nothing is
 * written back to the transcript.
 */
export interface CaptureCursor {
  /** Transcript entry the last successful capture ended at. */
  lastEntryId: string;
  /** ISO timestamp of that capture, for diagnostics and pruning. */
  lastCapturedAt: string;
}

/** The whole state file: one cursor per session, keyed by session id. */
export interface CaptureStateFile {
  version: 2;
  sessions: Record<string, CaptureCursor>;
}

/** Result of reading one session's cursor. */
export interface CaptureCursorReadResult {
  cursor?: CaptureCursor;
  /**
   * Set when the file exists but entries could not be used. Capture falls back
   * to the most recent turns, and the caller is expected to surface this rather
   * than let a stale or corrupt cursor pass as a clean session.
   */
  warning?: string;
}

/**
 * Resolves the state file location.
 *
 * It lives beside the extension's configuration rather than inside the memory
 * root: the cursor is session bookkeeping, and the memory root is
 * configuration-dependent (a house can point `memory.root` anywhere).
 */
export function captureStatePath(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, "pi-friend", "memory", CAPTURE_STATE_FILENAME);
}

/**
 * Reads one session's cursor.
 *
 * Several sessions can run concurrently and a house switches between them, so
 * the file holds a map rather than one position. A session that is not in the
 * map has no cursor, which is a normal first-capture state.
 */
export async function readCaptureCursor(
  filePath: string,
  sessionId: string,
): Promise<CaptureCursorReadResult> {
  const { state, warning } = await readStateFile(filePath);
  const cursor = state.sessions[sessionId];
  return {
    ...(cursor === undefined ? {} : { cursor: { ...cursor } }),
    ...(warning === undefined ? {} : { warning }),
  };
}

/**
 * Records one session's cursor, leaving every other session untouched.
 *
 * The read-modify-write is serialised through a module-level queue because two
 * captures can interleave at an `await`, and last-writer-wins would silently
 * drop the other session's entry — the exact failure this map exists to avoid.
 */
export async function writeCaptureCursor(
  filePath: string,
  sessionId: string,
  cursor: CaptureCursor,
  now: Date = new Date(),
): Promise<void> {
  await serialize(async () => {
    const { state } = await readStateFile(filePath);
    state.sessions[sessionId] = { ...cursor };
    const current = now.getTime();
    for (const [id, entry] of Object.entries(state.sessions)) {
      if (id === sessionId) {
        continue;
      }
      const captured = Date.parse(entry.lastCapturedAt);
      if (!Number.isFinite(captured) || current - captured > CAPTURE_STATE_MAX_AGE_MS) {
        delete state.sessions[id];
      }
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  });
}

/** Reads and validates the state file, translating the version 1 shape. */
async function readStateFile(
  filePath: string,
): Promise<{ state: CaptureStateFile; warning?: string }> {
  const empty: CaptureStateFile = {
    version: CAPTURE_STATE_VERSION,
    sessions: {},
  };

  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { state: empty };
    }
    return {
      state: empty,
      warning: `capture state ${filePath} could not be read (${
        getErrorCode(error) ?? "unknown error"
      }); ignoring saved cursors.`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      state: empty,
      warning: `capture state ${filePath} is not valid JSON; ignoring saved cursors.`,
    };
  }
  if (!isRecord(value)) {
    return {
      state: empty,
      warning: `capture state ${filePath} is not a JSON object; ignoring saved cursors.`,
    };
  }

  if (value.version === 1) {
    const migrated = migrateVersionOne(value);
    return migrated === undefined
      ? {
          state: empty,
          warning: `capture state ${filePath} is an unusable version 1 file; ignoring saved cursors.`,
        }
      : { state: { version: CAPTURE_STATE_VERSION, sessions: migrated } };
  }

  if (value.version !== CAPTURE_STATE_VERSION) {
    return {
      state: empty,
      warning: `capture state ${filePath} has version ${String(
        value.version,
      )}; this build reads version ${CAPTURE_STATE_VERSION} and ignores saved cursors.`,
    };
  }

  const sessions: Record<string, CaptureCursor> = {};
  let dropped = 0;
  const rawSessions = isRecord(value.sessions) ? value.sessions : {};
  for (const [sessionId, entry] of Object.entries(rawSessions)) {
    const cursor = parseCursor(entry);
    if (cursor === undefined) {
      dropped += 1;
      continue;
    }
    sessions[sessionId] = cursor;
  }
  if (dropped > 0) {
    return {
      state: { version: CAPTURE_STATE_VERSION, sessions },
      warning: `capture state ${filePath} holds ${dropped} unusable session ${
        dropped === 1 ? "entry" : "entries"
      }; ignoring ${dropped === 1 ? "it" : "them"}.`,
    };
  }
  return { state: { version: CAPTURE_STATE_VERSION, sessions } };
}

/** Translates one version 1 record into the version 2 map. */
function migrateVersionOne(
  value: Record<string, unknown>,
): Record<string, CaptureCursor> | undefined {
  const { sessionId } = value;
  const cursor = parseCursor(value);
  if (typeof sessionId !== "string" || sessionId === "" || cursor === undefined) {
    return undefined;
  }
  return { [sessionId]: cursor };
}

/** Validates one cursor entry. */
function parseCursor(value: unknown): CaptureCursor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { lastEntryId, lastCapturedAt } = value;
  if (
    typeof lastEntryId !== "string" ||
    lastEntryId === "" ||
    typeof lastCapturedAt !== "string"
  ) {
    return undefined;
  }
  return { lastEntryId, lastCapturedAt };
}

/** Runs state writes one at a time, so concurrent captures cannot clobber. */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(work, work);
  writeQueue = result.catch(() => undefined);
  return result;
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the Node error code when one is present. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
