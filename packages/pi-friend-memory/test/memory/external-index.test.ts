/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/memory/embedding.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/** Embedding provider that makes the imported marigold text easy to retrieve. */
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

test("bulk indexing imports plain Markdown idempotently and finds it semantically", async () => {
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
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-22T12:00:00.000Z"),
      { provider, index },
    );

    try {
      const first = await service.indexPath(oldCorpus, { cwd: agentDir });
      assert.equal(first.total, 1);
      assert.equal(first.chunks, 1);
      assert.equal(first.embedded, 1);
      assert.equal(first.skipped, 0);
      assert.equal(first.files[0]?.path, canonicalOldNote);
      assert.equal(first.files[0]?.title, "September Garden Log");
      assert.match(first.files[0]?.modifiedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(
        first.files[0]?.provenance,
        `imported; source: ${canonicalOldNote}`,
      );
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

      const second = await service.indexPath(oldCorpus, { cwd: agentDir });
      assert.equal(second.total, 1);
      assert.equal(second.embedded, 0);
      assert.equal(second.skipped, 1);
      assert.equal(index.count(), 1);
    } finally {
      index.close();
    }
  });
});

test("chunked external files reload as one searchable document", async () => {
  await withTempDir(async (agentDir) => {
    const configDir = path.join(agentDir, "pi-friend");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "pi-friend.yml"),
      "memory:\n  vector:\n    chunk_size: 200\n",
      "utf8",
    );

    const corpus = path.join(agentDir, "long-corpus");
    const note = path.join(corpus, "garden.md");
    await mkdir(corpus, { recursive: true });
    await writeFile(
      note,
      [
        "# Long Garden Log",
        "",
        `Cold notes. ${"soil ".repeat(80)}`,
        "A marigold glows beside the gate.",
        `More cold notes. ${"rain ".repeat(80)}`,
      ].join("\n\n"),
      "utf8",
    );

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
    const service = new MemoryNodeService(repository, undefined, {
      provider,
      index,
    });

    try {
      const imported = await service.indexPath(corpus, { cwd: agentDir });
      assert.equal(imported.total, 1);
      assert.ok(imported.chunks > 1);
      assert.equal(index.count(), imported.chunks);

      const results = await service.search({
        query: "marigold",
        mode: "semantic",
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.relativePath, await realpath(note));
      assert.match(results[0]?.snippet ?? "", /marigold glows/);
    } finally {
      index.close();
    }
  });
});
