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

/** File name of the persisted capture cursor inside the pi-friend state dir. */
export const CAPTURE_STATE_FILENAME = "capture-state.json";

/**
 * Durable record of how far auto-capture has read in one session.
 *
 * `lastEntryId` is a Pi transcript entry id, not a byte offset: Pi's session
 * format owns that identity and the extension only remembers it. Nothing is
 * written back to the transcript.
 */
export interface CaptureState {
  version: 1;
  /** Session the cursor belongs to; a different session starts fresh. */
  sessionId: string;
  /** Transcript entry the last successful capture ended at. */
  lastEntryId: string;
  /** ISO timestamp of that capture, for diagnostics only. */
  lastCapturedAt: string;
}

/** Result of reading the state file, which may be absent or unusable. */
export interface CaptureStateReadResult {
  state?: CaptureState;
  /**
   * Set when the file exists but could not be used. Capture starts from the
   * beginning of the branch, and the caller is expected to surface this rather
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

/** Reads the persisted cursor, treating absence as "no state yet". */
export async function readCaptureState(
  filePath: string,
): Promise<CaptureStateReadResult> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    return {
      warning: `capture state ${filePath} could not be read (${
        getErrorCode(error) ?? "unknown error"
      }); starting a fresh cursor.`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      warning: `capture state ${filePath} is not valid JSON; starting a fresh cursor.`,
    };
  }
  if (!isRecord(value)) {
    return {
      warning: `capture state ${filePath} is not a JSON object; starting a fresh cursor.`,
    };
  }
  if (value.version !== 1) {
    return {
      warning: `capture state ${filePath} has version ${String(
        value.version,
      )}; this build writes version 1 and starts a fresh cursor.`,
    };
  }
  const { sessionId, lastEntryId, lastCapturedAt } = value;
  if (
    typeof sessionId !== "string" ||
    sessionId === "" ||
    typeof lastEntryId !== "string" ||
    lastEntryId === "" ||
    typeof lastCapturedAt !== "string"
  ) {
    return {
      warning: `capture state ${filePath} is missing sessionId, lastEntryId or lastCapturedAt; starting a fresh cursor.`,
    };
  }
  return { state: { version: 1, sessionId, lastEntryId, lastCapturedAt } };
}

/**
 * Writes the cursor atomically, so a crash mid-write leaves the previous file.
 *
 * The temporary file sits beside the target rather than in the OS temp
 * directory: rename is only atomic within one filesystem.
 */
export async function writeCaptureState(
  filePath: string,
  state: CaptureState,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, filePath);
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
