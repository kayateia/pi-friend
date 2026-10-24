/**
 * pi-friend
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

/** Appends a structured prompt diagnostic when pi-friend debug logging is on. */
export function promptDebugLog(
  label: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!["1", "true", "yes"].includes(
    (env.PI_FRIEND_DEBUG_HOOKS ?? "").toLowerCase(),
  )) {
    return;
  }

  const configuredPath = env.PI_FRIEND_DEBUG_LOG?.trim();
  let logPath: string;
  if (configuredPath) {
    if (configuredPath === "~") {
      logPath = path.join(homedir(), "pi-friend-debug.log");
    } else if (
      configuredPath.startsWith("~/") ||
      configuredPath.startsWith("~\\")
    ) {
      logPath = path.join(homedir(), configuredPath.slice(2));
    } else {
      logPath = path.resolve(configuredPath);
    }
  } else {
    const agentDir = env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
    logPath = path.join(agentDir, "pi-friend", "debug.log");
  }

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
      `[${new Date().toISOString()}] [${label}]\n${formatted}\n\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (existsSync(logPath)) {
      chmodSync(logPath, 0o600);
    }
  } catch {
    // Diagnostics must never affect prompt generation.
  }
}
