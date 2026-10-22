/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat, mkdir, open, stat } from "node:fs/promises";
import type { MemoryPaths } from "./paths.ts";
import { MemoryPathError } from "./paths.ts";

/** Creates the complete private memory layout without overwriting content. */
export async function ensureMemoryLayout(paths: MemoryPaths): Promise<void> {
  await ensureDirectory(paths.root, true);

  for (const directory of [
    paths.nodes,
    paths.supersededNodes,
    paths.staging,
    paths.daily,
    paths.sweeps,
    paths.index,
    paths.recovery,
  ]) {
    await ensureDirectory(directory);
  }

  await ensureFile(paths.topOfMind);
  await ensureFile(paths.accessLog);
}

/**
 * Creates a directory with private permissions.
 *
 * The configured root may itself be a symlink. Nested layout directories may
 * not be symlinks because memory writes must remain inside the intended tree.
 */
async function ensureDirectory(
  directory: string,
  allowRootSymlink = false,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);

  if (stats.isSymbolicLink()) {
    if (!allowRootSymlink) {
      throw new MemoryPathError(
        `Memory layout directory must not be a symbolic link: ${directory}`,
      );
    }

    const followed = await stat(directory);
    if (!followed.isDirectory()) {
      throw new MemoryPathError(`Memory root is not a directory: ${directory}`);
    }
    return;
  }

  if (!stats.isDirectory()) {
    throw new MemoryPathError(`Memory layout path is not a directory: ${directory}`);
  }
}

/** Creates a private empty file only when the target does not already exist. */
async function ensureFile(filePath: string): Promise<void> {
  try {
    const handle = await open(filePath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") {
      throw error;
    }

    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new MemoryPathError(
        `Memory layout file must be a regular file: ${filePath}`,
      );
    }
  }
}

/** Returns a Node filesystem error code without relying on an any cast. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
