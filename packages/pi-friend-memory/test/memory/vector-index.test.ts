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

test("index rejects embedding-space mismatches and invalid vectors", async () => {
  await withTempDir(async (directory) => {
    const databasePath = path.join(directory, "vectors.sqlite");
    const index = openIndex(databasePath);
    try {
      assert.throws(
        () =>
          SqliteVectorIndex.open({
            databasePath,
            model: "different/model",
            dimensions: 4,
          }),
        VectorIndexError,
      );
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
