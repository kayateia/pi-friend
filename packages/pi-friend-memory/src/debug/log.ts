/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { inspect } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_ERROR_CAUSES = 8;
const DEFAULT_ERROR_DEDUPE_MS = 60_000;
const MAX_RECENT_ERROR_LOGS = 1_000;
const recentErrorLogs = new Map<string, number>();

/** Options for persistent operational error logging. */
export interface ErrorLogOptions {
  /** Overrides the configured diagnostic log path. */
  logPath?: string;
  /** Environment used for path resolution. */
  env?: NodeJS.ProcessEnv;
  /** Suppresses repeated identical entries within this interval. */
  dedupeMs?: number;
  /** Clock override for deterministic tests. */
  now?: number;
  /**
   * Extra diagnostic payload written under the error text.
   *
   * Exists for the case where the interesting evidence is not the exception
   * but what the program was holding when it threw — a model's raw response,
   * for one. It is inspected into the same private log entry, so it never
   * reaches a UI warning.
   */
  detail?: unknown;
}

/** One formatted entry in an error's cause chain. */
interface ErrorChainEntry {
  name: string;
  message: string;
  stack?: string;
}

/** Returns whether debug logging is enabled for the supplied environment. */
export function isDebugEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ["1", "true", "yes"].includes(
    (env.PI_FRIEND_DEBUG_HOOKS ?? "").toLowerCase(),
  );
}

/** Resolves the debug log path, honoring an explicit environment override. */
export function resolveDebugLogPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PI_FRIEND_DEBUG_LOG?.trim();
  if (configured) {
    if (configured === "~") return path.join(homedir(), "pi-friend-debug.log");
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return path.join(homedir(), configured.slice(2));
    }
    return path.resolve(configured);
  }
  const agentDir =
    env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
  return path.join(agentDir, "pi-friend", "debug.log");
}

/** Appends one structured debug entry to the configured log file. */
export function writeDebugLog(
  label: string,
  value: unknown,
  options: {
    enabled?: boolean;
    logPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const enabled = options.enabled ?? isDebugEnabled(options.env);
  if (!enabled) return;

  const logPath = options.logPath ?? resolveDebugLogPath(options.env);
  const timestamp = new Date().toISOString();
  const formatted =
    typeof value === "string"
      ? value
      : inspect(value, {
          colors: false,
          compact: 3,
          breakLength: 120,
          depth: 8,
          maxArrayLength: 100,
          maxStringLength: 12_000,
        });

  try {
    mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(
      logPath,
      `[${timestamp}] [${label}]\n${formatted}\n\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (existsSync(logPath)) {
      chmodSync(logPath, 0o600);
    }
  } catch {
    // Debug logging must never interrupt Pi.
  }
}

/** Appends one debug entry using the process environment. */
export function debugLog(label: string, value: unknown): void {
  writeDebugLog(label, value);
}

/**
 * Formats an exception and its cause chain for a user-visible diagnostic.
 *
 * Stacks are omitted here because this text may appear in a short UI warning.
 */
export function formatErrorChain(error: unknown): string {
  return collectErrorChain(error)
    .map((entry, index) =>
      index === 0
        ? `${entry.name}: ${entry.message}`
        : `caused by ${entry.name}: ${entry.message}`,
    )
    .join("; ");
}

/** Formats an exception and its causes with available stack traces. */
export function formatErrorDetails(error: unknown): string {
  return collectErrorChain(error)
    .map((entry, index) => {
      const prefix = index === 0 ? "Error" : `Caused by ${index}`;
      const heading = `[${prefix}] ${entry.name}: ${entry.message}`;
      return entry.stack ? `${heading}\n${entry.stack}` : heading;
    })
    .join("\n\n");
}

/**
 * Appends unexpected operational errors even when debug logging is disabled.
 *
 * Errors are written to the existing diagnostic log with mode 0600. Repeated
 * identical entries are suppressed for a short interval so a failing watcher or
 * degraded RAG path does not flood the file.
 */
export function logError(
  label: string,
  error: unknown,
  options: ErrorLogOptions = {},
): void {
  const details = formatErrorDetails(error);
  const key = `${label}\u0000${details}`;
  const now = options.now ?? Date.now();
  const dedupeMs = options.dedupeMs ?? DEFAULT_ERROR_DEDUPE_MS;
  const previous = recentErrorLogs.get(key);
  if (previous !== undefined && now - previous < dedupeMs) {
    return;
  }
  if (recentErrorLogs.size >= MAX_RECENT_ERROR_LOGS) {
    recentErrorLogs.clear();
  }
  recentErrorLogs.set(key, now);

  const entry =
    options.detail === undefined
      ? details
      : `${details}\n\n${inspect(options.detail, {
          colors: false,
          compact: 3,
          breakLength: 120,
          depth: 8,
          maxArrayLength: 100,
          maxStringLength: 12_000,
        })}`;
  writeDebugLog(`error ${label}`, entry, {
    enabled: true,
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/** Traverses Error.cause links while guarding against malformed cycles. */
function collectErrorChain(error: unknown): ErrorChainEntry[] {
  const entries: ErrorChainEntry[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current !== undefined && entries.length < MAX_ERROR_CAUSES) {
    if (seen.has(current)) {
      entries.push({
        name: "Circular cause",
        message: "Error cause chain contains a cycle.",
      });
      break;
    }
    seen.add(current);

    if (current instanceof Error) {
      entries.push({
        name: current.name || "Error",
        message: current.message || "(no message)",
        ...(current.stack === undefined ? {} : { stack: current.stack }),
      });
      current = current.cause;
      continue;
    }

    entries.push({
      name: "Thrown value",
      message: String(current),
    });
    break;
  }

  if (entries.length === MAX_ERROR_CAUSES && current !== undefined) {
    entries.push({
      name: "Truncated cause",
      message: `More than ${MAX_ERROR_CAUSES} causes were present.`,
    });
  }
  return entries;
}
