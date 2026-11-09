/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { MemoryStore } from "../../src/memory/store.ts";
import { buildMemoryDocumentIndex } from "../../src/memory/indexer.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { withTempDir } from "../helpers.ts";

test("Markdown replacement preserves exact text", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    const exactText = "Café ☕\r\nNo final newline";

    await store.writeTextFile("nodes/topic.md", exactText);

    assert.equal(await store.readTextFile("nodes/topic.md"), exactText);
    const nodeDirectory = path.dirname(path.join(store.paths.nodes, "topic.md"));
    const leftovers = await readdir(nodeDirectory);
    assert.deepEqual(
      leftovers.filter((name) => name.includes(".tmp")),
      [],
    );
  });
});

test("the access log remains append-only", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });

    await store.appendAccessLog({
      timestamp: "2026-10-19T20:00:00.000Z",
      source: "rag",
      slug: "topic",
      mode: "hybrid",
    });

    const accessLines = (await store.readTextFile("access-log"))
      .trim()
      .split("\n");
    assert.equal(accessLines.length, 1);
    assert.deepEqual(JSON.parse(accessLines[0] ?? "") as unknown, {
      timestamp: "2026-10-19T20:00:00.000Z",
      source: "rag",
      slug: "topic",
      mode: "hybrid",
    });

    await assert.rejects(
      () => store.writeTextFile("access-log", "replacement"),
      /must use the \.md extension/,
    );
    await assert.rejects(
      () => store.removeTextFile("access-log"),
      /append-only/,
    );
  });
});

test("file inventory classifies memory and skips bookkeeping", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    for (const relativePath of [
      "nodes/topic.md",
      "nodes/superseded/old.md",
      "staging/candidate.md",
      "docs/reference.md",
      "MEMORY.md",
      // Bookkeeping, none of which is memory: a sweep log, a preimage copy of a
      // real node, a dropped candidate, and the vector index.
      "sweeps/2026-10-19.md",
      "sweeps/preimages/2026-10-19T00-00-00-000Z/nodes/topic.md",
      "sweeps/dropped/2026-10-19/discarded.md",
      "index/state.md",
    ]) {
      await store.writeTextFile(relativePath, relativePath);
    }

    const files = await store.listMarkdownFiles();
    assert.deepEqual(
      files.map((file) => [file.relativePath, file.kind]),
      [
        ["MEMORY.md", "document"],
        ["docs/reference.md", "document"],
        ["nodes/superseded/old.md", "node"],
        ["nodes/topic.md", "node"],
        ["staging/candidate.md", "staging-candidate"],
      ],
    );
  });
});

test("a preimage of a node never appears in the search index", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const path = "sweeps/preimages/2026-11-03T00-00-00-000Z/nodes/ghost.md";
    await repository.store.writeTextFile(
      path,
      [
        "---",
        "title: Ghost",
        "type: fact",
        "speaker: [{ name: Aisling, confident: true }]",
        "created: 2026-11-03T00:00:00Z",
        "last_used: 2026-11-03T00:00:00Z",
        "use_count: 0",
        "decay_weight: 1",
        "status: active",
        "emotional_flavour: neutral",
        "tags: []",
        "supersedes: []",
        "superseded_by: \"\"",
        "links: []",
        "source: \"\"",
        "---",
        "",
        "A snapshot of something that used to be true.",
      ].join("\n"),
    );

    const index = await buildMemoryDocumentIndex(repository.store);
    assert.equal(
      index.some((file) => file.relativePath.includes("preimages")),
      false,
    );
  });
});

test("storage rejects traversal and symlinked files", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    const outsideFile = path.join(agentDir, "outside.md");
    await writeFile(outsideFile, "outside", "utf8");
    await mkdir(store.paths.nodes, { recursive: true });
    await symlink(outsideFile, path.join(store.paths.nodes, "linked.md"));

    await assert.rejects(
      () => store.readTextFile("../outside.md"),
      /Parent-directory segments/,
    );
    await assert.rejects(
      () => store.readTextFile("nodes/linked.md"),
      /Symbolic links/,
    );

    const files = await store.listMarkdownFiles();
    assert.equal(files.some((file) => file.relativePath === "nodes/linked.md"), false);
  });
});

test("node helpers validate slugs and preserve created files", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    await store.writeNodeText("warm-memory", "content");

    assert.equal(await store.readNodeText("warm-memory"), "content");
    assert.equal(
      await readFile(path.join(store.paths.nodes, "warm-memory.md"), "utf8"),
      "content",
    );
    await assert.rejects(() => store.readNodeText("../escape"), /Slug/);
  });
});

test("legacy daily paths are treated as ordinary Markdown", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    await store.writeTextFile("daily/2026-10-19.md", "first");
    await store.writeTextFile("daily/2026-10-19.md", "replacement");
    assert.equal(
      await store.readTextFile("daily/2026-10-19.md"),
      "replacement",
    );
  });
});
