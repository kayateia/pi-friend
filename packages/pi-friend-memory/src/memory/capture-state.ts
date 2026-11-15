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

/**
 * Current on-disk shape.
 *
 * Version 1 held a single session's cursor and version 2 a map of them.
 * Version 3 adds the host that owns each session and dates the *record* rather
 * than the capture: one `modifiedAt` serves the ageing rule and any reader
 * asking when something last happened to the record, and `lastEntryId` became
 * optional so a session can be owned before it has been captured.
 */
export const CAPTURE_STATE_VERSION = 3;

/** Records older than this are pruned on write. */
export const CAPTURE_STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * Environment variable that names this machine.
 *
 * Deliberately unprefixed and set outside the container: the configuration
 * directory is synced between machines, so a name stored there would be the
 * same on both and could not tell them apart. Unset means "no identity", and
 * every rule that depends on one then behaves as it did before it existed.
 */
export const HOST_IDENTITY_ENV = "HOST_IDENTITY";

/**
 * One session's capture record.
 *
 * `host` names whoever most recently received a user message in the session.
 * It gates the idle-time capture, so a host holding a synced copy of a session
 * does not run its own extraction pass over material the other host is already
 * capturing — two passes over the same turns stage duplicate candidates.
 *
 * Both `host` and `lastEntryId` are optional. A session can be owned before it
 * has ever been captured, and a file written by an older build has a position
 * but no owner.
 */
export interface CaptureCursor {
  /** Host that last received a user message in this session. */
  host?: string;
  /** Transcript entry the last successful capture ended at. */
  lastEntryId?: string;
  /** When this record last changed: a capture, or an ownership stamp. */
  modifiedAt: string;
}

/** The whole state file: one record per session, keyed by session id. */
export interface CaptureStateFile {
  version: 3;
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

/** Returns this machine's configured name, or undefined when it has none. */
export function resolveHostIdentity(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env[HOST_IDENTITY_ENV]?.trim();
  return configured === undefined || configured === "" ? undefined : configured;
}

/**
 * Returns whether this host may capture the session the record describes.
 *
 * A session belongs to the host that last received a user message in it, and
 * only that host runs its own capture; the other copy is a mirror. Two cases
 * are deliberately permissive, because refusing them would lose capture rather
 * than duplicate it: no identity configured on this machine, and a record from
 * before hosts were recorded. Both behave exactly as they did before the guard.
 */
export function cursorBelongsToHost(
  cursor: CaptureCursor | undefined,
  localHost: string | undefined,
): boolean {
  const host = localHost?.trim().toLowerCase();
  if (host === undefined || host === "") {
    return true;
  }
  const owner = cursor?.host?.trim().toLowerCase();
  if (owner === undefined || owner === "") {
    return true;
  }
  return owner === host;
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
 * Records one session's completed capture, leaving other sessions untouched.
 *
 * The host is written unconditionally: whoever last moved the cursor owns the
 * session until someone speaks on the other machine again. A host with no
 * identity of its own leaves any recorded owner alone rather than clearing it.
 */
export async function writeCaptureCursor(
  filePath: string,
  sessionId: string,
  capture: { host?: string; lastEntryId: string },
  now: Date = new Date(),
): Promise<void> {
  await updateSession(filePath, sessionId, now, (existing) => ({
    ...(capture.host === undefined
      ? existing?.host === undefined
        ? {}
        : { host: existing.host }
      : { host: capture.host.trim() }),
    lastEntryId: capture.lastEntryId,
    modifiedAt: now.toISOString(),
  }));
}

/**
 * Claims one session for this host, creating a record when there is none.
 *
 * Called when a user message arrives, which is the only thing that moves
 * ownership. Writes only when the recorded owner differs, so a conversation on
 * a host that already owns the session never touches the file — every write
 * moves the file's timestamp, and those timestamps are what a sync tool
 * compares.
 *
 * Returns whether the file changed.
 */
export async function stampCaptureHost(
  filePath: string,
  sessionId: string,
  host: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = host.trim();
  if (claimed === "") {
    return false;
  }
  let changed = false;
  await updateSession(filePath, sessionId, now, (existing) => {
    if (existing?.host?.trim().toLowerCase() === claimed.toLowerCase()) {
      return undefined;
    }
    changed = true;
    return {
      ...(existing?.lastEntryId === undefined
        ? {}
        : { lastEntryId: existing.lastEntryId }),
      host: claimed,
      modifiedAt: now.toISOString(),
    };
  });
  return changed;
}

/**
 * Applies one change to one session's record and rewrites the file.
 *
 * The read-modify-write is serialised through a module-level queue because two
 * writers can interleave at an `await`, and last-writer-wins would silently
 * drop the other session's entry — the exact failure the map exists to avoid.
 * Returning nothing from `update` means "no change", and then nothing is
 * written at all.
 */
async function updateSession(
  filePath: string,
  sessionId: string,
  now: Date,
  update: (existing: CaptureCursor | undefined) => CaptureCursor | undefined,
): Promise<void> {
  await serialize(async () => {
    const { state } = await readStateFile(filePath);
    const next = update(state.sessions[sessionId]);
    if (next === undefined) {
      return;
    }
    state.sessions[sessionId] = next;
    const current = now.getTime();
    for (const [id, entry] of Object.entries(state.sessions)) {
      if (id === sessionId) {
        continue;
      }
      const modified = Date.parse(entry.modifiedAt);
      if (!Number.isFinite(modified) || current - modified > CAPTURE_STATE_MAX_AGE_MS) {
        delete state.sessions[id];
      }
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  });
}

/**
 * Reads and validates the state file, translating the older shapes.
 *
 * Version 2 is read rather than refused because both hosts are upgraded one at
 * a time: until the second is running this build, it writes records with no
 * `host`, and refusing them would make this host re-capture sessions the other
 * host had already done.
 */
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

  if (value.version === 2) {
    const sessions = migrateSessions(value.sessions, migrateVersionTwoRecord);
    return sessions === undefined
      ? {
          state: empty,
          warning: `capture state ${filePath} has an unusable version 2 body; ignoring saved cursors.`,
        }
      : { state: { version: CAPTURE_STATE_VERSION, sessions } };
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

/** Translates one version 1 record into the current map. */
function migrateVersionOne(
  value: Record<string, unknown>,
): Record<string, CaptureCursor> | undefined {
  const { sessionId } = value;
  const cursor = migrateVersionTwoRecord(value);
  if (typeof sessionId !== "string" || sessionId === "" || cursor === undefined) {
    return undefined;
  }
  return { [sessionId]: cursor };
}

/** Translates one version 2 record: the capture time becomes the record's. */
function migrateVersionTwoRecord(
  entry: unknown,
): CaptureCursor | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const { lastEntryId, lastCapturedAt } = entry;
  if (
    typeof lastEntryId !== "string" ||
    lastEntryId === "" ||
    typeof lastCapturedAt !== "string"
  ) {
    return undefined;
  }
  return { lastEntryId, modifiedAt: lastCapturedAt };
}

/** Applies one migration to a version 2 session map. */
function migrateSessions(
  value: unknown,
  migrate: (entry: unknown) => CaptureCursor | undefined,
): Record<string, CaptureCursor> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessions: Record<string, CaptureCursor> = {};
  for (const [sessionId, entry] of Object.entries(value)) {
    const cursor = migrate(entry);
    if (cursor !== undefined) {
      sessions[sessionId] = cursor;
    }
  }
  return sessions;
}

/** Validates one current-shape record. */
function parseCursor(value: unknown): CaptureCursor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { host, lastEntryId, modifiedAt } = value;
  if (typeof modifiedAt !== "string" || modifiedAt === "") {
    return undefined;
  }
  const cursor: CaptureCursor = { modifiedAt };
  if (lastEntryId !== undefined) {
    if (typeof lastEntryId !== "string" || lastEntryId === "") {
      return undefined;
    }
    cursor.lastEntryId = lastEntryId;
  }
  if (host !== undefined) {
    if (typeof host !== "string" || host.trim() === "") {
      return undefined;
    }
    cursor.host = host;
  }
  // A record naming neither an owner nor a position says nothing about the
  // session and cannot guide capture, so it is treated as unusable.
  if (cursor.host === undefined && cursor.lastEntryId === undefined) {
    return undefined;
  }
  return cursor;
}

/** Runs state writes one at a time, so concurrent writers cannot clobber. */
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
