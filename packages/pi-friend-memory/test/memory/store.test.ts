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

test("daily logs and the access log are append-only", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });

    await store.appendDaily("2026-10-19", "first\n");
    await store.appendDaily("2026-10-19", "second\n");
    await store.appendAccessLog({
      timestamp: "2026-10-19T20:00:00.000Z",
      source: "rag",
      slug: "topic",
      tier: "fresh",
    });

    assert.equal(
      await store.readTextFile("daily/2026-10-19.md"),
      "first\nsecond\n",
    );
    const accessLines = (await store.readTextFile("access-log"))
      .trim()
      .split("\n");
    assert.equal(accessLines.length, 1);
    assert.deepEqual(JSON.parse(accessLines[0] ?? "") as unknown, {
      timestamp: "2026-10-19T20:00:00.000Z",
      source: "rag",
      slug: "topic",
      tier: "fresh",
    });

    await assert.rejects(
      () => store.writeTextFile("daily/2026-10-19.md", "replacement"),
      /append-only/,
    );
    await assert.rejects(
      () => store.writeTextFile("access-log", "replacement"),
      /must use the \.md extension/,
    );
  });
});

test("concurrent daily appends are serialized", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    const entries = Array.from({ length: 20 }, (_, index) => `${index}\n`);

    await Promise.all(
      entries.map((entry) => store.appendDaily("2026-10-19", entry)),
    );

    const content = await store.readTextFile("daily/2026-10-19.md");
    assert.equal(content.split("\n").filter(Boolean).length, entries.length);
  });
});

test("file inventory classifies nodes and documents and skips index state", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    for (const relativePath of [
      "nodes/topic.md",
      "nodes/superseded/old.md",
      "staging/candidate.md",
      "sweeps/2026-10-19.md",
      "docs/reference.md",
      "MEMORY.md",
      "index/state.md",
    ]) {
      await store.writeTextFile(relativePath, relativePath);
    }
    await store.appendDaily("2026-10-19", "daily record\n");

    const files = await store.listMarkdownFiles();
    assert.deepEqual(
      files.map((file) => [file.relativePath, file.kind]),
      [
        ["MEMORY.md", "document"],
        ["daily/2026-10-19.md", "document"],
        ["docs/reference.md", "document"],
        ["nodes/superseded/old.md", "node"],
        ["nodes/topic.md", "node"],
        ["staging/candidate.md", "staging-candidate"],
        ["sweeps/2026-10-19.md", "document"],
      ],
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

test("invalid daily dates are rejected", async () => {
  await withTempDir(async (agentDir) => {
    const store = await MemoryStore.open({ agentDir, homeDir: agentDir });
    await assert.rejects(
      () => store.appendDaily("2026-02-30", "invalid"),
      /Invalid daily date/,
    );
  });
});
