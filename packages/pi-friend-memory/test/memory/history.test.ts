/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { ParsedMemoryNode } from "../../src/memory/schema.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import {
  historyEntryPath,
  listHistoryVersions,
  pruneHistory,
  pruneHistorySlug,
  readHistoryEntry,
  writeHistoryEntry,
} from "../../src/memory/history.ts";
import { MemoryPathError } from "../../src/memory/paths.ts";
import { withTempDir } from "../helpers.ts";

const TIMESTAMP = "2026-11-05T06:40:01.658Z";

test("single-file kinds are named after the slug, versions after a timestamp", () => {
  assert.equal(historyEntryPath("deleted", "blue-cup"), "history/deleted/blue-cup.md");
  assert.equal(historyEntryPath("dropped", "blue-cup"), "history/dropped/blue-cup.md");
  assert.equal(
    historyEntryPath("edited", "blue-cup", TIMESTAMP),
    `history/edited/blue-cup/${TIMESTAMP}.md`,
  );
  assert.equal(
    historyEntryPath("merged", "blue-cup", TIMESTAMP),
    `history/merged/blue-cup/${TIMESTAMP}.md`,
  );
});

test("version kinds require an ISO timestamp file name", () => {
  for (const bad of [undefined, "", "2026-11-05", "2026-11-05T06:40:01Z", "../x"]) {
    assert.throws(
      () => historyEntryPath("edited", "blue-cup", bad),
      MemoryPathError,
      String(bad),
    );
  }
});

test("history paths reject unsafe slugs", () => {
  assert.throws(() => historyEntryPath("deleted", "../escape"), MemoryPathError);
});

test("a written version reads back with its history field, outside search", async () => {
  await withTempDir(async (directory) => {
    const repository = await MemoryNodeRepository.open({
      agentDir: directory,
      homeDir: directory,
    });
    const store = repository.store;
    const node = await repository.read("missing").catch(() => null);
    assert.equal(node, null);

    const original = {
      slug: "blue-cup",
      body: "\nThe blue cup belongs on the second shelf.\n",
      frontMatter: {
        title: "Blue Cup",
        type: "fact" as const,
        speaker: [{ name: "Aisling", confident: true }],
        agents: [],
        created: "2026-10-19T20:00:00.000Z",
        last_used: "2026-10-19T20:00:00.000Z",
        use_count: 0,
        decay_weight: 1,
        status: "active" as const,
        emotional_flavour: "neutral",
        tags: ["kitchen"],
        supersedes: [],
        superseded_by: "",
        links: [],
        source: "",
        history_reason: "Corrected the shelf",
      },
    };

    const relativePath = await writeHistoryEntry(store, {
      kind: "edited",
      slug: original.slug,
      timestamp: TIMESTAMP,
      node: original,
    });

    const read = await readHistoryEntry(store, relativePath, original.slug);
    assert.ok(read);
    assert.equal(read.frontMatter.title, "Blue Cup");
    assert.equal(read.frontMatter.history_reason, "Corrected the shelf");
    assert.match(read.body, /second shelf/);

    // History is not part of the searchable tree.
    const searchable = await store.listMarkdownFiles();
    assert.deepEqual(
      searchable.filter((file) => file.relativePath.startsWith("history/")),
      [],
    );

    assert.deepEqual(
      await listHistoryVersions(store, "edited", original.slug),
      [relativePath],
    );
    assert.deepEqual(await listHistoryVersions(store, "edited", "other"), []);
  });
});

test("history-only front matter is refused on a live node", async () => {
  await withTempDir(async (directory) => {
    const repository = await MemoryNodeRepository.open({
      agentDir: directory,
      homeDir: directory,
    });
    await assert.rejects(
      () =>
        repository.write({
          slug: "blue-cup",
          body: "\nBody.\n",
          frontMatter: {
            title: "Blue Cup",
            type: "fact",
            speaker: [{ name: "Aisling", confident: true }],
            agents: [],
            created: "2026-10-19T20:00:00.000Z",
            last_used: "2026-10-19T20:00:00.000Z",
            use_count: 0,
            decay_weight: 1,
            status: "active",
            emotional_flavour: "neutral",
            tags: [],
            supersedes: [],
            superseded_by: "",
            links: [],
            source: "",
            history_reason: "leaked",
          },
        }),
      /history-only front matter/u,
    );
  });
});

/** Builds a minimal node for retention tests. */
function makeNode(slug: string): ParsedMemoryNode {
  return {
    slug,
    body: "\nA body worth keeping.\n",
    frontMatter: {
      title: `Memory ${slug}`,
      type: "fact",
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created: "2026-01-01T00:00:00.000Z",
      last_used: "2026-01-01T00:00:00.000Z",
      use_count: 0,
      decay_weight: 1,
      status: "active",
      emotional_flavour: "neutral",
      tags: [],
      supersedes: [],
      superseded_by: "",
      links: [],
      source: "",
    },
  };
}

test("retention deletes versions older than keep_days and keeps newer ones", async () => {
  await withTempDir(async (directory) => {
    const repository = await MemoryNodeRepository.open({
      agentDir: directory,
      homeDir: directory,
    });
    const store = repository.store;
    const old = "2026-09-01T00:00:00.000Z";
    const recent = "2026-11-04T00:00:00.000Z";
    await writeHistoryEntry(store, {
      kind: "edited",
      slug: "blue-cup",
      timestamp: old,
      node: makeNode("blue-cup"),
    });
    await writeHistoryEntry(store, {
      kind: "edited",
      slug: "blue-cup",
      timestamp: recent,
      node: makeNode("blue-cup"),
    });
    await writeHistoryEntry(store, {
      kind: "merged",
      slug: "only-old",
      timestamp: old,
      node: makeNode("only-old"),
    });

    const result = await pruneHistory(store, new Date("2026-11-05T00:00:00.000Z"));

    assert.equal(result.removed, 2);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(
      await store.listDirectoryMarkdown("history/edited/blue-cup"),
      [`history/edited/blue-cup/${recent}.md`],
    );
    // A slug directory with nothing left is removed with its last version.
    assert.deepEqual(await store.listDirectoryMarkdown("history/merged/only-old"), []);
    assert.deepEqual(await store.listDirectories("history/merged"), []);
  });
});

test("keep_days of zero keeps every version", async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(
      directory,
      "pi-friend",
      "pi-friend-memory.yml",
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        "memory:",
        `  root: ${path.join(directory, "memory")}`,
        "  history:",
        "    keep_days: 0",
      ].join("\n"),
      "utf8",
    );

    const repository = await MemoryNodeRepository.open({
      agentDir: directory,
      homeDir: directory,
    });
    const store = repository.store;
    assert.equal(store.config.history.keepDays, 0);
    await writeHistoryEntry(store, {
      kind: "edited",
      slug: "ancient",
      timestamp: "2020-01-01T00:00:00.000Z",
      node: makeNode("ancient"),
    });

    const result = await pruneHistory(store, new Date("2030-01-01T00:00:00.000Z"));
    assert.equal(result.removed, 0);
    assert.equal(
      (await store.listDirectoryMarkdown("history/edited/ancient")).length,
      1,
    );
  });
});

test("a single-file deletion entry is pruned by its own age", async () => {
  await withTempDir(async (directory) => {
    const repository = await MemoryNodeRepository.open({
      agentDir: directory,
      homeDir: directory,
    });
    const store = repository.store;
    const relativePath = await writeHistoryEntry(store, {
      kind: "deleted",
      slug: "long-gone",
      node: makeNode("long-gone"),
    });
    const past = new Date("2026-06-01T00:00:00.000Z");
    await utimes(
      path.join(store.root, relativePath),
      past,
      past,
    );

    const result = await pruneHistory(store, new Date("2026-11-05T00:00:00.000Z"));
    assert.equal(result.removed, 1);
    assert.equal(await store.readTextFileIfExists(relativePath), null);
  });
});

test("pruning one slug leaves the others alone", async () => {
  await withTempDir(async (directory) => {
    const repository = await MemoryNodeRepository.open({
      agentDir: directory,
      homeDir: directory,
    });
    const store = repository.store;
    const old = "2026-09-01T00:00:00.000Z";
    for (const slug of ["first", "second"]) {
      await writeHistoryEntry(store, {
        kind: "edited",
        slug,
        timestamp: old,
        node: makeNode(slug),
      });
    }

    const removed = await pruneHistorySlug(
      store,
      "edited",
      "first",
      new Date("2026-11-05T00:00:00.000Z"),
    );
    assert.equal(removed, 1);
    assert.deepEqual(await store.listDirectoryMarkdown("history/edited/first"), []);
    assert.equal(
      (await store.listDirectoryMarkdown("history/edited/second")).length,
      1,
    );
  });
});
