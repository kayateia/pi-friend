/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkText,
  resolveChunkOverlap,
} from "../../src/memory/chunker.ts";

test("chunking keeps short text intact and splits longer text deterministically", () => {
  assert.deepEqual(chunkText("  short text  ", 20), [
    { index: 0, content: "short text" },
  ]);

  const source = "abcdefghij".repeat(6);
  const first = chunkText(source, 20, 4);
  const second = chunkText(source, 20, 4);

  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.deepEqual(
    first.map((chunk) => chunk.index),
    first.map((_, index) => index),
  );
  assert.ok(first.every((chunk) => chunk.content.length <= 20));
  assert.ok(first.every((chunk) => chunk.content !== ""));
});

test("chunking prefers a late paragraph boundary", () => {
  const source = [
    "A".repeat(30),
    "B".repeat(30),
    "C".repeat(30),
  ].join("\n\n");
  const chunks = chunkText(source, 80, 0);

  assert.equal(
    chunks[0]?.content,
    `${"A".repeat(30)}\n\n${"B".repeat(30)}`,
  );
  assert.equal(chunks[1]?.content, "C".repeat(30));
});

test("default overlap scales down for small chunk sizes", () => {
  assert.equal(resolveChunkOverlap(200), 40);
  assert.equal(resolveChunkOverlap(1_000), 200);
  assert.equal(resolveChunkOverlap(10_000), 200);
});
