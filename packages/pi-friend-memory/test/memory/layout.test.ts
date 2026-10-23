/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { ensureMemoryLayout } from "../../src/memory/layout.ts";
import { createMemoryPaths } from "../../src/memory/paths.ts";
import { withTempDir } from "../helpers.ts";

test("layout creation is idempotent and preserves existing content", async () => {
  await withTempDir(async (directory) => {
    const paths = createMemoryPaths(
      path.join(directory, "memory"),
      path.join(directory, "pi-friend.yml"),
    );

    await ensureMemoryLayout(paths);
    await writeFile(paths.topOfMind, "# Existing memory\n", "utf8");
    await ensureMemoryLayout(paths);

    assert.equal(
      await readFile(paths.topOfMind, "utf8"),
      "# Existing memory\n",
    );

    for (const directoryPath of [
      paths.nodes,
      paths.supersededNodes,
      paths.staging,
      paths.sweeps,
      paths.index,
      paths.recovery,
    ]) {
      await access(directoryPath);
      assert.equal((await lstat(directoryPath)).mode & 0o777, 0o700);
    }

    assert.equal((await lstat(paths.accessLog)).mode & 0o777, 0o600);
  });
});

test("layout refuses a symlinked nested directory", async () => {
  await withTempDir(async (directory) => {
    const paths = createMemoryPaths(
      path.join(directory, "memory"),
      path.join(directory, "pi-friend.yml"),
    );
    const { mkdir, symlink } = await import("node:fs/promises");
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await mkdir(paths.root, { recursive: true });
    await symlink(outside, paths.nodes);

    await assert.rejects(() => ensureMemoryLayout(paths), /symbolic link/);
  });
});
