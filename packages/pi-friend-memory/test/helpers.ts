/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Runs a test body with environment variables set, restoring them afterwards.
 *
 * Production reads some flags straight from `process.env`, so a test that needs
 * one on has to put it there. Files run in separate processes under
 * `node --test`, so this cannot leak into another file; restoring keeps it from
 * leaking between tests in the same one.
 */
export async function withEnv<T>(
  vars: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Runs a test body with an isolated temporary directory. */
export async function withTempDir(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
