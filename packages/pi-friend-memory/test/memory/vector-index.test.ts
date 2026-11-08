/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  SqliteVectorIndex,
  VectorIndexError,
} from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/** Opens a small three-dimensional test index. */
function openIndex(databasePath: string): SqliteVectorIndex {
  return SqliteVectorIndex.open({
    databasePath,
    model: "test/three-dimensional",
    dimensions: 3,
  });
}

test("sqlite-vec index stores, searches, updates, and removes records", async () => {
  await withTempDir(async (directory) => {
    const databasePath = path.join(directory, "index", "vectors.sqlite");
    const index = openIndex(databasePath);
    try {
      index.upsert({
        key: "east",
        kind: "node",
        sourcePath: "nodes/east.md",
        contentHash: "hash-east",
        embedding: new Float32Array([1, 0, 0]),
        title: "East",
        type: "fact",
        status: "active",
        decayWeight: 1,
        tags: ["direction"],
      });
      index.upsert({
        key: "diagonal",
        kind: "document",
        sourcePath: "docs/diagonal.md",
        contentHash: "hash-diagonal",
        embedding: new Float32Array([0.7, 0.7, 0]),
        tags: [],
      });
      index.upsert({
        key: "north",
        kind: "node",
        sourcePath: "nodes/north.md",
        contentHash: "hash-north",
        embedding: new Float32Array([0, 1, 0]),
        type: "event",
        status: "active",
        tags: [],
      });

      const first = index.search(new Float32Array([0.9, 0.1, 0]));
      assert.deepEqual(
        first.map((hit) => hit.key),
        ["east", "diagonal", "north"],
      );
      assert.equal(first[0]?.title, "East");
      assert.deepEqual(first[0]?.tags, ["direction"]);
      assert.equal(index.count(), 3);

      index.upsert({
        key: "east",
        kind: "node",
        sourcePath: "nodes/east.md",
        contentHash: "hash-east-updated",
        embedding: new Float32Array([0, 0, 1]),
        title: "Updated East",
        type: "preference",
        status: "active",
        decayWeight: 0.5,
        tags: ["updated"],
      });
      const updated = index.search(new Float32Array([0, 0, 1]), 1);
      assert.equal(updated[0]?.key, "east");
      assert.equal(updated[0]?.contentHash, "hash-east-updated");
      assert.equal(updated[0]?.type, "preference");
      assert.deepEqual(updated[0]?.tags, ["updated"]);
      assert.equal(index.count(), 3);

      assert.equal(index.remove("diagonal"), true);
      assert.equal(index.remove("diagonal"), false);
      assert.equal(index.count(), 2);
    } finally {
      index.close();
    }

    assert.equal((await lstat(databasePath)).mode & 0o777, 0o600);
  });
});

test("index persists across reopen and rebuild clears stale rows", async () => {
  await withTempDir(async (directory) => {
    const databasePath = path.join(directory, "vectors.sqlite");
    const first = openIndex(databasePath);
    first.upsert({
      key: "persisted",
      kind: "node",
      sourcePath: "nodes/persisted.md",
      contentHash: "hash-persisted",
      embedding: new Float32Array([1, 0, 0]),
      tags: [],
    });
    first.close();

    const reopened = openIndex(databasePath);
    try {
      assert.equal(reopened.count(), 1);
      reopened.rebuild([
        {
          key: "rebuilt",
          kind: "document",
          sourcePath: "docs/rebuilt.md",
          contentHash: "hash-rebuilt",
          embedding: new Float32Array([0, 0, 1]),
          tags: [],
        },
      ]);
      assert.equal(reopened.count(), 1);
      assert.deepEqual(
        reopened.search(new Float32Array([0, 0, 1])).map((hit) => hit.key),
        ["rebuilt"],
      );
      reopened.clear();
      assert.equal(reopened.count(), 0);
    } finally {
      reopened.close();
    }
  });
});

test("index rejects invalid vectors", async () => {
  await withTempDir(async (directory) => {
    const databasePath = path.join(directory, "vectors.sqlite");
    const index = openIndex(databasePath);
    try {
      assert.throws(
        () =>
          index.upsert({
            key: "wrong-size",
            kind: "node",
            sourcePath: "nodes/wrong.md",
            contentHash: "hash",
            embedding: new Float32Array([1, 0]),
            tags: [],
          }),
        /expected 3/,
      );
      assert.throws(
        () =>
          index.upsert({
            key: "nan",
            kind: "node",
            sourcePath: "nodes/nan.md",
            contentHash: "hash",
            embedding: new Float32Array([1, Number.NaN, 0]),
            tags: [],
          }),
        /non-finite/,
      );
    } finally {
      index.close();
    }
  });
});

test("an index written under an older schema is discarded and rebuilt", async () => {
  await withTempDir(async (directory) => {
    const databasePath = path.join(directory, "vectors.sqlite");
    const old = SqliteVectorIndex.open({
      databasePath,
      model: "test/three-dimensional",
      dimensions: 3,
      schemaVersion: 1,
    });
    try {
      old.upsert({
        key: "east",
        kind: "node",
        sourcePath: "nodes/east.md",
        contentHash: "hash-east",
        embedding: new Float32Array([1, 0, 0]),
        tags: [],
      });
      assert.equal(old.count(), 1);
    } finally {
      old.close();
    }

    const current = openIndex(databasePath);
    try {
      assert.equal(current.rebuilt, true);
      assert.equal(current.count(), 0);
      current.upsert({
        key: "east",
        kind: "node",
        sourcePath: "nodes/east.md",
        contentHash: "hash-east",
        embedding: new Float32Array([1, 0, 0]),
        modifiedAt: "2026-11-08T00:00:00.000Z",
        tags: [],
      });
      assert.equal(current.listEntries()[0]?.modifiedAt, "2026-11-08T00:00:00.000Z");
    } finally {
      current.close();
    }
  });
});

test("an index written for a different embedding space is discarded and rebuilt", async () => {
  await withTempDir(async (directory) => {
    const databasePath = path.join(directory, "vectors.sqlite");
    const original = openIndex(databasePath);
    try {
      original.upsert({
        key: "east",
        kind: "node",
        sourcePath: "nodes/east.md",
        contentHash: "hash-east",
        embedding: new Float32Array([1, 0, 0]),
        tags: [],
      });
    } finally {
      original.close();
    }

    const replaced = SqliteVectorIndex.open({
      databasePath,
      model: "different/model",
      dimensions: 4,
    });
    try {
      assert.equal(replaced.rebuilt, true);
      assert.equal(replaced.count(), 0);
    } finally {
      replaced.close();
    }
  });
});

test("filters restrict the search before the nearest-neighbour cutoff", async () => {
  await withTempDir(async (directory) => {
    const index = openIndex(path.join(directory, "vectors.sqlite"));
    try {
      // Four old memories sit closer to the query than the two new ones, which
      // is the case a filter applied to results cannot survive: the top `k` are
      // all outside the window, so the window looks empty.
      index.upsert({
        key: "old-1",
        kind: "node",
        sourcePath: "nodes/old-1.md",
        contentHash: "h1",
        embedding: new Float32Array([1, 0, 0]),
        type: "fact",
        status: "active",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        tags: [],
      });
      index.upsert({
        key: "old-2",
        kind: "node",
        sourcePath: "nodes/old-2.md",
        contentHash: "h2",
        embedding: new Float32Array([0.99, 0.1, 0]),
        type: "event",
        status: "active",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        tags: [],
      });
      index.upsert({
        key: "old-3",
        kind: "document",
        sourcePath: "docs/old-3.md",
        contentHash: "h3",
        embedding: new Float32Array([0.98, 0.2, 0]),
        modifiedAt: "2026-01-03T00:00:00.000Z",
        tags: [],
      });
      index.upsert({
        key: "old-4",
        kind: "node",
        sourcePath: "nodes/old-4.md",
        contentHash: "h4",
        embedding: new Float32Array([0.97, 0.3, 0]),
        type: "fact",
        status: "candidate",
        modifiedAt: "2026-01-04T00:00:00.000Z",
        tags: [],
      });
      index.upsert({
        key: "undated",
        kind: "node",
        sourcePath: "nodes/undated.md",
        contentHash: "h5",
        embedding: new Float32Array([0.999, 0.001, 0]),
        type: "fact",
        status: "active",
        tags: [],
      });
      index.upsert({
        key: "new-1",
        kind: "node",
        sourcePath: "nodes/new-1.md",
        contentHash: "h6",
        embedding: new Float32Array([0.2, 1, 0]),
        type: "fact",
        status: "active",
        modifiedAt: "2026-11-01T00:00:00.000Z",
        tags: [],
      });
      index.upsert({
        key: "new-2",
        kind: "node",
        sourcePath: "nodes/new-2.md",
        contentHash: "h7",
        embedding: new Float32Array([0.1, 1, 0]),
        type: "fact",
        status: "active",
        modifiedAt: "2026-11-02T00:00:00.000Z",
        tags: [],
      });

      const query = new Float32Array([1, 0, 0]);
      const keys = (hits: { key: string }[]): string[] =>
        hits.map((hit) => hit.key);

      assert.deepEqual(keys(index.search(query, 3)), [
        "old-1",
        "undated",
        "old-2",
      ]);
      // The same three-slot budget, with the window applied first: the nearest
      // entries *inside* it, rather than the survivors of a top-three list.
      assert.deepEqual(
        keys(index.search(query, 3, { since: "2026-10-01T00:00:00.000Z" })),
        ["new-1", "new-2"],
      );
      // A bound that every dated entry satisfies still excludes the undated
      // one, which would otherwise be second-nearest of all: a date condition
      // is a requirement, not a comparison that a NULL may quietly fail.
      assert.deepEqual(
        keys(index.search(query, 3, { since: "2020-01-01T00:00:00.000Z" })),
        ["old-1", "old-2", "old-3"],
      );
      assert.deepEqual(
        keys(index.search(query, 3, { kinds: ["document"] })),
        ["old-3"],
      );
      assert.deepEqual(
        keys(index.search(query, 3, { type: "event" })),
        ["old-2"],
      );
      assert.deepEqual(
        keys(index.search(query, 3, { status: "candidate" })),
        ["old-4"],
      );
      assert.deepEqual(
        keys(index.search(query, 3, { kinds: [] })),
        [],
      );
      assert.deepEqual(
        keys(
          index.search(query, 3, {
            kinds: ["node"],
            type: "fact",
            status: "active",
            since: "2026-10-01T00:00:00.000Z",
            until: "2026-11-01T00:00:00.000Z",
          }),
        ),
        ["new-1"],
      );
    } finally {
      index.close();
    }
  });
});
