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
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/memory/embedding.ts";
import { ExternalIndexManager } from "../../src/memory/external-index-manager.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/** Deterministic embedding provider with one vector per non-empty input. */
class ManagerTestProvider implements EmbeddingProvider {
  readonly model = "test/external-manager";
  readonly dimensions = 2;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) =>
      text.toLowerCase().includes("marigold")
        ? new Float32Array([1, 0])
        : new Float32Array([0, 1]),
    );
  }
}

test("external manager reconciles initial paths and removes stale vectors", async () => {
  await withTempDir(async (agentDir) => {
    const corpus = path.join(agentDir, "notes");
    const first = path.join(corpus, "first.md");
    const second = path.join(corpus, "nested", "second.md");
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(first, "# First\n\nThe marigold is active.\n", "utf8");
    await writeFile(second, "# Second\n\nA quiet garden note.\n", "utf8");

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const provider = new ManagerTestProvider();
    const index = SqliteVectorIndex.open({
      databasePath: ":memory:",
      model: provider.model,
      dimensions: provider.dimensions,
    });
    index.upsert({
      key: "external:stale.md",
      kind: "document",
      sourcePath: "/old/stale.md",
      contentHash: "stale",
      embedding: new Float32Array([0, 1]),
      tags: [],
    });
    index.upsert({
      key: "nodes/internal.md",
      kind: "node",
      sourcePath: "nodes/internal.md",
      contentHash: "internal",
      embedding: new Float32Array([0, 1]),
      tags: [],
    });

    const warnings: string[] = [];
    const reported: Array<{ label: string; error: unknown }> = [];
    const manager = new ExternalIndexManager({
      indexPaths: [corpus, await realpath(corpus), first],
      memoryRoot: repository.store.root,
      semantic: { provider, index },
      chunkSize: 4_000,
      reportWarning: (message) => warnings.push(message),
      reportError: (label, error) => reported.push({ label, error }),
      debounceMs: 10,
      usePolling: true,
    });

    try {
      await manager.start();
      assert.equal(manager.getFiles().length, 2);
      assert.equal(index.count(), 3);
      assert.equal(
        index.listEntries().some((entry) => entry.key === "external:stale.md"),
        false,
      );
      assert.equal(
        index.listEntries().some((entry) => entry.key === "nodes/internal.md"),
        true,
      );

      await rm(first);
      await manager.rescan();
      assert.deepEqual(
        manager.getFiles().map((file) => file.absolutePath),
        [await realpath(second)],
      );
      assert.equal(index.count(), 2);
      assert.equal(
        warnings.some((warning) => warning.includes("first.md")),
        true,
      );
      assert.equal(reported[0]?.label, "external index path");
      assert.match(String(reported[0]?.error), /Could not resolve/u);
    } finally {
      await manager.stop();
      index.close();
    }
  });
});

test("external manager watches additions and deletions", async () => {
  await withTempDir(async (agentDir) => {
    const corpus = path.join(agentDir, "watched");
    const note = path.join(corpus, "new-note.md");
    await mkdir(corpus, { recursive: true });

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const provider = new ManagerTestProvider();
    const index = SqliteVectorIndex.open({
      databasePath: ":memory:",
      model: provider.model,
      dimensions: provider.dimensions,
    });
    const manager = new ExternalIndexManager({
      indexPaths: [corpus],
      memoryRoot: repository.store.root,
      semantic: { provider, index },
      chunkSize: 4_000,
      reportWarning: () => undefined,
      debounceMs: 10,
      usePolling: true,
    });

    try {
      await manager.start();
      assert.equal(manager.getFiles().length, 0);

      await writeFile(note, "# Watched\n\nThe marigold appeared.\n", "utf8");
      await waitFor(() => manager.getFiles().length === 1);
      assert.equal(index.count(), 1);

      await writeFile(note, "# Watched\n\nThe marigold changed colour.\n", "utf8");
      await waitFor(() =>
        manager
          .getFiles()
          .some((file) => file.body.includes("changed colour")),
      );

      await rm(note);
      await waitFor(() => manager.getFiles().length === 0);
      assert.equal(index.count(), 0);

      await rm(corpus, { recursive: true });
      await waitFor(() => manager.getFiles().length === 0);
      await mkdir(corpus, { recursive: true });
      await writeFile(note, "# Recreated\n\nThe marigold returned.\n", "utf8");
      await waitFor(() => manager.getFiles().length === 1);
    } finally {
      await manager.stop();
      index.close();
    }
  });
});

test("external manager exposes keyword sources without embeddings", async () => {
  await withTempDir(async (agentDir) => {
    const corpus = path.join(agentDir, "keyword-only");
    await mkdir(corpus, { recursive: true });
    await writeFile(
      path.join(corpus, "note.md"),
      "# Keyword only\n\nA daffodil waits by the window.\n",
      "utf8",
    );

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const manager = new ExternalIndexManager({
      indexPaths: [corpus],
      memoryRoot: repository.store.root,
      chunkSize: 4_000,
      reportWarning: () => undefined,
      usePolling: true,
    });

    try {
      await manager.start();
      assert.equal(manager.getFiles().length, 1);
      assert.match(manager.getFiles()[0]?.body ?? "", /daffodil/u);
    } finally {
      await manager.stop();
    }
  });
});

/** Waits briefly for asynchronous watcher and reconciliation callbacks. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for external index reconciliation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
