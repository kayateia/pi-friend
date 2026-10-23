/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/memory/embedding.ts";
import type { IndexedMarkdownFile } from "../../src/memory/indexer.ts";
import {
  buildEmbeddingText,
  hashEmbeddingText,
  hashVectorInput,
  synchronizeVectorIndex,
} from "../../src/memory/vector-sync.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";

/** Deterministic embedding provider with call accounting. */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fake/model";
  readonly dimensions = 3;
  calls: string[][] = [];
  fail = false;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    if (this.fail) {
      throw new Error("embedding failure");
    }
    return texts.map((text) => {
      const hash = hashEmbeddingText(text);
      return new Float32Array([
        (hash.charCodeAt(0) % 100) / 100,
        (hash.charCodeAt(1) % 100) / 100,
        (hash.charCodeAt(2) % 100) / 100,
      ]);
    });
  }
}

/** Builds one searchable file fixture. */
function makeFile(
  relativePath: string,
  body: string,
  title = "Title",
): IndexedMarkdownFile {
  return {
    absolutePath: `/memory/${relativePath}`,
    relativePath,
    storageKind: "document",
    kind: "document",
    title,
    tags: ["tag"],
    body,
  };
}

test("vector synchronization hashes content and only embeds changes", async () => {
  const index = SqliteVectorIndex.open({
    databasePath: ":memory:",
    model: "fake/model",
    dimensions: 3,
  });
  const provider = new FakeEmbeddingProvider();
  try {
    const firstFiles = [
      makeFile("docs/one.md", "First body"),
      makeFile("docs/two.md", "Second body"),
      {
        ...makeFile("MEMORY.md", ""),
        title: undefined,
        tags: [],
      },
    ];
    const first = await synchronizeVectorIndex(firstFiles, provider, index);
    assert.deepEqual(first, {
      total: 2,
      embedded: 2,
      skipped: 0,
      removed: 0,
    });
    assert.equal(provider.calls.length, 1);

    const second = await synchronizeVectorIndex(firstFiles, provider, index);
    assert.deepEqual(second, {
      total: 2,
      embedded: 0,
      skipped: 2,
      removed: 0,
    });
    assert.equal(provider.calls.length, 1);

    const changedFiles = [
      firstFiles[0]!,
      makeFile("docs/two.md", "Changed body"),
    ];
    const third = await synchronizeVectorIndex(changedFiles, provider, index);
    assert.deepEqual(third, {
      total: 2,
      embedded: 1,
      skipped: 1,
      removed: 0,
    });
    const entries = index.listEntries();
    const two = entries.find((entry) => entry.key === "docs/two.md");
    assert.equal(
        two?.contentHash,
        hashVectorInput(
          changedFiles[1]!,
          buildEmbeddingText(changedFiles[1]!),
        ),
    );
  } finally {
    index.close();
  }
});

test("vector synchronization removes stale entries and is failure-safe", async () => {
  const index = SqliteVectorIndex.open({
    databasePath: ":memory:",
    model: "fake/model",
    dimensions: 3,
  });
  const provider = new FakeEmbeddingProvider();
  try {
    const file = makeFile("docs/current.md", "Current body");
    await synchronizeVectorIndex([file], provider, index);
    index.upsert({
      key: "docs/stale.md",
      kind: "document",
      sourcePath: "docs/stale.md",
      contentHash: "stale",
      embedding: new Float32Array([0, 0, 1]),
      tags: [],
    });

    const result = await synchronizeVectorIndex([file], provider, index);
    assert.equal(result.removed, 1);
    assert.equal(
      index.listEntries().some((entry) => entry.key === "docs/stale.md"),
      false,
    );

    const beforeFailure = index.listEntries();
    provider.fail = true;
    await assert.rejects(
      () =>
        synchronizeVectorIndex(
          [makeFile("docs/new.md", "New body")],
          provider,
          index,
        ),
      /embedding failure/,
    );
    assert.deepEqual(index.listEntries(), beforeFailure);
  } finally {
    index.close();
  }
});

test("metadata-only changes refresh vector metadata", async () => {
  const index = SqliteVectorIndex.open({
    databasePath: ":memory:",
    model: "fake/model",
    dimensions: 3,
  });
  const provider = new FakeEmbeddingProvider();
  try {
    const original: IndexedMarkdownFile = {
      ...makeFile("nodes/node.md", "Stable body"),
      storageKind: "node",
      kind: "node",
      type: "fact",
      status: "active",
      decayWeight: 1,
    };
    await synchronizeVectorIndex([original], provider, index);
    const updated = { ...original, decayWeight: 0.5 };
    const result = await synchronizeVectorIndex([updated], provider, index);

    assert.equal(result.embedded, 1);
    assert.equal(index.listEntries()[0]?.decayWeight, 0.5);
  } finally {
    index.close();
  }
});

test("long documents synchronize as stable vector chunks", async () => {
  const index = SqliteVectorIndex.open({
    databasePath: ":memory:",
    model: "fake/model",
    dimensions: 3,
  });
  const provider = new FakeEmbeddingProvider();
  try {
    const file = makeFile(
      "docs/long.md",
      [
        `First section. ${"alpha ".repeat(50)}`,
        `Second section. ${"beta ".repeat(50)}`,
        `Third section. ${"gamma ".repeat(50)}`,
      ].join("\n\n"),
    );
    const first = await synchronizeVectorIndex(
      [file],
      provider,
      index,
      { chunkSize: 200 },
    );

    assert.ok(first.total > 1);
    assert.equal(first.embedded, first.total);
    assert.equal(index.count(), first.total);
    const entries = index.listEntries();
    assert.ok(
      entries.every(
        (entry) =>
          entry.sourcePath === "docs/long.md" &&
          entry.key.startsWith("docs/long.md#chunk:"),
      ),
    );

    const callsAfterFirst = provider.calls.length;
    const second = await synchronizeVectorIndex(
      [file],
      provider,
      index,
      { chunkSize: 200 },
    );
    assert.equal(second.embedded, 0);
    assert.equal(second.skipped, first.total);
    assert.equal(provider.calls.length, callsAfterFirst);

    const changed = {
      ...file,
      body: `${file.body}\n\nFourth section. ${"delta ".repeat(30)}`,
    };
    const third = await synchronizeVectorIndex(
      [changed],
      provider,
      index,
      { chunkSize: 200 },
    );
    assert.ok(third.embedded > 0);
    assert.ok(third.embedded < third.total);
  } finally {
    index.close();
  }
});
