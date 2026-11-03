/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  buildIndexPathFiles,
} from "../../src/memory/external-index.ts";
import {
  MemoryConfigError,
  parseMemoryConfig,
} from "../../src/memory/config.ts";
import { ensureMemoryLayout } from "../../src/memory/layout.ts";
import { createMemoryPaths } from "../../src/memory/paths.ts";
import {
  RESERVED_MEMORY_PATHS,
  compileExcludePattern,
  compileExcludePatterns,
  isExcludedPath,
} from "../../src/memory/index-exclude.ts";
import { withTempDir } from "../helpers.ts";

test("exclusion patterns match segments, subtrees, and recursive globs", () => {
  const excludes = compileExcludePatterns([
    "/home/example/private",
    "/home/example/notes/drafts/*.md",
    "/home/example/journal/**/scratch.md",
  ]);

  assert.equal(isExcludedPath("/home/example/private", "/root", excludes), true);
  assert.equal(
    isExcludedPath("/home/example/private/deeper/file.md", "/root", excludes),
    true,
  );
  assert.equal(
    isExcludedPath("/home/example/notes/drafts/one.md", "/root", excludes),
    true,
  );
  assert.equal(
    isExcludedPath("/home/example/notes/drafts/keep.txt", "/root", excludes),
    false,
  );
  assert.equal(
    isExcludedPath("/home/example/journal/2026/03/scratch.md", "/root", excludes),
    true,
  );
  assert.equal(
    isExcludedPath("/home/example/journal/2026/03/kept.md", "/root", excludes),
    false,
  );
  assert.equal(
    isExcludedPath("/home/example/notes/kept.md", "/root", excludes),
    false,
  );
});

test("a glob with no wildcard is an exact path, and ? matches one character", () => {
  assert.equal(
    compileExcludePattern("/a/b/c.md").pattern.test("/a/b/c.md"),
    true,
  );
  assert.equal(
    compileExcludePattern("/a/b/c.md").pattern.test("/a/b/c.md.bak"),
    false,
  );
  assert.equal(compileExcludePattern("/a/?.md").pattern.test("/a/b.md"), true);
  assert.equal(compileExcludePattern("/a/?.md").pattern.test("/a/bc.md"), false);
});

test("only the extension's own paths under the root are reserved", () => {
  const root = "/home/example/memory";

  for (const owned of [
    "nodes/a.md",
    "nodes/superseded/b.md",
    "staging/c.md",
    "sweeps/2026-11-03.md",
    "sweeps/dropped/run/x.md",
    "recovery/0f0f.json",
    "index/vectors.sqlite",
    "access-log",
  ]) {
    assert.equal(isExcludedPath(path.join(root, owned), root, []), true, owned);
  }

  // Everything else under the root is ordinary Markdown and may be indexed.
  for (const allowed of [
    "loose.md",
    "notes/journal.md",
    "nodes-archive/old.md",
    "sweeps-notes/summary.md",
  ]) {
    assert.equal(isExcludedPath(path.join(root, allowed), root, []), false, allowed);
  }

  // The root is not excluded as a whole, and a sibling is never touched.
  assert.equal(isExcludedPath(root, root, []), false);
  assert.equal(isExcludedPath(`${root}-other/x.md`, root, []), false);
});

test("indexing a parent of the memory root skips owned paths but not neighbours", async () => {
  await withTempDir(async (directory) => {
    const memoryRoot = path.join(directory, "store");
    const notes = path.join(directory, "notes");
    await mkdir(path.join(memoryRoot, "nodes"), { recursive: true });
    await mkdir(path.join(memoryRoot, "staging"), { recursive: true });
    await mkdir(path.join(memoryRoot, "index"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(
      path.join(memoryRoot, "nodes", "a-memory.md"),
      "# A memory\n",
      "utf8",
    );
    await writeFile(
      path.join(memoryRoot, "index", "chunk.md"),
      "# Index artefact\n",
      "utf8",
    );
    await writeFile(
      path.join(memoryRoot, "loose-note.md"),
      "# Loose note beside the store\n",
      "utf8",
    );
    await writeFile(path.join(notes, "keep.md"), "# Keep\n", "utf8");
    await writeFile(path.join(notes, "rough.draft.md"), "# Draft\n", "utf8");
    await mkdir(path.join(notes, "private"), { recursive: true });
    await writeFile(
      path.join(notes, "private", "secret.md"),
      "# Secret\n",
      "utf8",
    );

    const prepared = await buildIndexPathFiles(directory, {
      cwd: directory,
      memoryRoot,
      exclude: compileExcludePatterns([
        path.join(notes, "*.draft.md"),
        path.join(notes, "private"),
      ]),
    });

    assert.deepEqual(
      prepared.files.map((file) => file.absolutePath),
      [
        path.join(memoryRoot, "loose-note.md"),
        path.join(notes, "keep.md"),
      ].sort(),
    );
  });
});

test("the created layout and the reserved prefixes agree", async () => {
  await withTempDir(async (directory) => {
    const root = path.join(directory, "memory");
    const paths = createMemoryPaths(root, path.join(directory, "pi-friend-memory.yml"));
    await ensureMemoryLayout(paths);

    // Every top-level entry the layout creates is reserved, and so is the nested
    // tombstone directory inside nodes/.
    const created = (await readdir(root)).sort();
    assert.deepEqual(created, [
      "access-log",
      "index",
      "nodes",
      "recovery",
      "staging",
      "sweeps",
    ]);
    for (const entry of created) {
      assert.equal(isExcludedPath(path.join(root, entry), root, []), true, entry);
    }
    assert.equal(
      isExcludedPath(path.join(root, "nodes", "superseded"), root, []),
      true,
    );

    // Content the layout does not create stays indexable.
    const foreign = path.join(root, "foreign.md");
    await writeFile(foreign, "# Foreign\n", "utf8");
    assert.equal(isExcludedPath(foreign, root, []), false);
  });
});

test("the reserved prefixes stay derived from the layout declaration", () => {
  // Pinned deliberately: this is not a second source of truth, it is a tripwire.
  // If the layout grows a directory, this fails and someone decides — with the
  // docs and the README — whether the new path should be excluded rather than
  // letting the derivation do it silently.
  assert.deepEqual(RESERVED_MEMORY_PATHS, [
    "access-log",
    "index",
    "nodes",
    "recovery",
    "staging",
    "sweeps",
  ]);
});

test("index_exclude resolves patterns beside the config and reports no typo", () => {
  const configPath = path.join(path.sep, "tmp", "agent", "pi-friend", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  index_paths:",
      "    - ~/notes",
      "  index_exclude:",
      "    - private",
      "    - '**/*.draft.md'",
    ].join("\n"),
    configPath,
    "/Users/example",
  );

  assert.deepEqual(config.indexExclude, [
    path.join(path.sep, "tmp", "agent", "pi-friend", "private"),
    path.join(path.sep, "tmp", "agent", "pi-friend", "**", "*.draft.md"),
  ]);
  assert.deepEqual(config.warnings, []);
});

test("invalid index_exclude values fail closed", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  assert.throws(
    () => parseMemoryConfig("memory:\n  index_exclude: private\n", configPath),
    MemoryConfigError,
  );
  assert.throws(
    () => parseMemoryConfig('memory:\n  index_exclude: [""]\n', configPath),
    MemoryConfigError,
  );
});
