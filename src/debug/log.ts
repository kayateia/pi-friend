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
