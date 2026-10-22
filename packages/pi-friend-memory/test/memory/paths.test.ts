/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
  classifyMemoryMarkdown,
  MemoryPathError,
  resolveWithin,
  validateSlug,
} from "../../src/memory/paths.ts";

test("valid slugs are accepted", () => {
  assert.equal(validateSlug("warm-memory-42"), "warm-memory-42");
});

test("invalid and traversal-like slugs are rejected", () => {
  for (const slug of ["", "../escape", "Upper", "two--hyphens", "has/slash"]) {
    assert.throws(() => validateSlug(slug), MemoryPathError);
  }
});

test("resolveWithin rejects absolute paths and traversal", () => {
  const root = path.resolve(path.sep, "tmp", "memory");
  assert.throws(() => resolveWithin(root, "../outside"), MemoryPathError);
  assert.throws(
    () => resolveWithin(root, path.resolve(path.sep, "tmp", "outside")),
    MemoryPathError,
  );
  assert.throws(() => resolveWithin(root, "..\\outside"), MemoryPathError);
  assert.throws(
    () => resolveWithin(root, "nodes/../MEMORY.md"),
    MemoryPathError,
  );
});

test("memory Markdown files are classified by location", () => {
  assert.equal(classifyMemoryMarkdown("nodes/topic.md"), "node");
  assert.equal(
    classifyMemoryMarkdown("nodes/superseded/topic.md"),
    "node",
  );
  assert.equal(
    classifyMemoryMarkdown("staging/candidate.md"),
    "staging-candidate",
  );
  assert.equal(classifyMemoryMarkdown("daily/2026-10-19.md"), "document");
  assert.equal(classifyMemoryMarkdown("MEMORY.md"), "document");
});
