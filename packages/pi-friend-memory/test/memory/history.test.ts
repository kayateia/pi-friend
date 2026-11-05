/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import {
  historyEntryPath,
  listHistoryVersions,
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
        emotional_flavor: "neutral",
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
            emotional_flavor: "neutral",
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
