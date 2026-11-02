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
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/memory/embedding.ts";
import { ExternalIndexManager } from "../../src/memory/external-index-manager.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/** Embedding provider that makes imported marigold text easy to retrieve. */
class ImportTestProvider implements EmbeddingProvider {
  readonly model = "test/import";
  readonly dimensions = 2;
  inputBatches: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.inputBatches.push([...texts]);
    return texts.map((text) =>
      text.toLowerCase().includes("marigold")
        ? new Float32Array([1, 0])
        : new Float32Array([0, 1]),
    );
  }
}

test("configured Markdown is searchable semantically with import metadata", async () => {
  await withTempDir(async (agentDir) => {
    const oldCorpus = path.join(agentDir, "old-memory");
    const oldNote = path.join(oldCorpus, "notes", "2026-09-01.md");
    await mkdir(path.dirname(oldNote), { recursive: true });
    await writeFile(
      oldNote,
      [
        "# September Garden Log",
        "",
        "The marigold by the east window survived the first frost.",
        "",
      ].join("\n"),
      "utf8",
    );
    const canonicalOldNote = await realpath(oldNote);

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const provider = new ImportTestProvider();
    const index = SqliteVectorIndex.open({
      databasePath: ":memory:",
      model: provider.model,
      dimensions: provider.dimensions,
    });
    const manager = new ExternalIndexManager({
      indexPaths: [oldCorpus],
      memoryRoot: repository.store.root,
      semantic: { provider, index },
      chunkSize: repository.store.config.vector.chunkSize,
      reportWarning: () => undefined,
      usePolling: true,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-22T12:00:00.000Z"),
      { provider, index },
      manager,
    );

    try {
      await manager.start();
      assert.equal(index.count(), 1);

      const results = await service.search({
        query: "marigold frost",
        mode: "semantic",
      });
      assert.equal(results[0]?.relativePath, canonicalOldNote);
      assert.equal(results[0]?.kind, "document");
      assert.equal(
        results[0]?.provenance,
        `imported; source: ${canonicalOldNote}`,
      );
      assert.match(results[0]?.snippet ?? "", /marigold by the east window/);

      const callsBeforeSearch = provider.inputBatches.length;
      await service.search({
        query: "marigold frost",
        mode: "semantic",
      });
      assert.equal(provider.inputBatches.length, callsBeforeSearch + 1);
    } finally {
      await manager.stop();
      index.close();
    }
  });
});

test("configured Markdown remains searchable by keyword without embeddings", async () => {
  await withTempDir(async (agentDir) => {
    const corpus = path.join(agentDir, "keyword-source");
    const note = path.join(corpus, "workshop.md");
    await mkdir(corpus, { recursive: true });
    await writeFile(
      note,
      "# Workshop Notes\n\nReplace the soldering iron tip.\n",
      "utf8",
    );

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const manager = new ExternalIndexManager({
      indexPaths: [corpus],
      memoryRoot: repository.store.root,
      chunkSize: repository.store.config.vector.chunkSize,
      reportWarning: () => undefined,
      usePolling: true,
    });
    const service = new MemoryNodeService(
      repository,
      undefined,
      undefined,
      manager,
    );

    try {
      await manager.start();
      const results = await service.search({
        query: "soldering iron",
        mode: "keyword",
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.title, "Workshop Notes");
      assert.match(results[0]?.snippet ?? "", /soldering iron/u);
    } finally {
      await manager.stop();
    }
  });
});
