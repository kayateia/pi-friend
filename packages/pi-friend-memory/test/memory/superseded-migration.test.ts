/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SUPERSEDED_MIGRATION_ID,
  migrateSupersededFrontMatter,
  migrationsPath,
  stripSupersededFields,
} from "../../src/memory/migrations.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { parseMemoryNode } from "../../src/memory/schema.ts";
import { withTempDir } from "../helpers.ts";

/**
 * A node file in the pre-migration shape.
 *
 * The two retired keys were required front matter, so every stored file carries
 * them; the fixture reproduces that rather than omitting what a real store has.
 */
function legacyNodeFile(
  slug: string,
  options: {
    status?: string;
    decayWeight?: string;
    supersedes?: string;
    supersededBy?: string;
    body?: string;
  } = {},
): string {
  return `---
title: ${slug}
type: fact
speaker: []
agents: []
created: 2026-10-01T00:00:00Z
last_used: 2026-10-01T00:00:00Z
use_count: 0
decay_weight: ${options.decayWeight ?? "1"}
status: ${options.status ?? "active"}
emotional_flavour: neutral
tags: []
supersedes: ${options.supersedes ?? "[]"}
superseded_by: ${options.supersededBy ?? '""'}
links: []
source: ""
---

${options.body ?? `Body of ${slug}.`}
`;
}

/** The same fixture with both retired keys removed, i.e. the schema's shape. */
function currentNodeFile(slug: string, status = "active"): string {
  return legacyNodeFile(slug, { status })
    .replace("supersedes: []\n", "")
    .replace('superseded_by: ""\n', "");
}

test("the retired keys are no longer schema fields", () => {
  assert.doesNotThrow(() => parseMemoryNode(currentNodeFile("old"), "old"));

  for (const key of ["supersedes", "superseded_by"]) {
    const withKey = currentNodeFile("old").replace(
      "tags: []\n",
      `tags: []\n${key}: ${key === "supersedes" ? "[]" : '""'}\n`,
    );
    assert.throws(
      () => parseMemoryNode(withKey, "old"),
      new RegExp(`Unknown front-matter field "${key}"`),
      `${key} must be unknown rather than silently ignored`,
    );
  }
});

test("status superseded is no longer an approved status", () => {
  assert.throws(
    () => parseMemoryNode(currentNodeFile("old", "superseded"), "old"),
    /must be one of: active, candidate, archived/u,
  );
});

test("the migration strips both keys from nodes, staging and history", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;

    await store.writeTextFile("nodes/one.md", legacyNodeFile("one"));
    await store.writeTextFile(
      "staging/draft.md",
      legacyNodeFile("draft", { status: "candidate" }),
    );
    await store.writeTextFile(
      "history/deleted/gone.md",
      legacyNodeFile("gone"),
    );
    // A file that never carried the keys is left byte-for-byte alone.
    const clean = legacyNodeFile("clean")
      .replace("supersedes: []\n", "")
      .replace('superseded_by: ""\n', "");
    await store.writeTextFile("nodes/clean.md", clean);

    const outcome = await stripSupersededFields(store, agentDir);

    assert.equal(outcome?.status, "applied");
    assert.deepEqual(outcome?.changed.sort(), [
      "history/deleted/gone.md",
      "nodes/one.md",
      "staging/draft.md",
    ]);
    assert.deepEqual(outcome?.skipped, []);
    assert.equal(await store.readTextFile("nodes/clean.md"), clean);

    for (const path of [
      "nodes/one.md",
      "staging/draft.md",
      "history/deleted/gone.md",
    ]) {
      const text = await store.readTextFile(path);
      assert.doesNotMatch(text, /^supersedes:/mu, path);
      assert.doesNotMatch(text, /^superseded_by:/mu, path);
      assert.match(text, /^tags: \[\]$/mu, path);
    }

    // Every area parses again, which is the reason the pass runs first.
    assert.deepEqual(
      (await repository.list("canonical")).map((node) => node.slug).sort(),
      ["clean", "one"],
    );
    assert.deepEqual(
      (await repository.list("staging")).map((node) => node.slug),
      ["draft"],
    );

    const record = JSON.parse(
      await readFile(migrationsPath(agentDir), "utf8"),
    ) as { applied: string[] };
    assert.ok(record.applied.includes(SUPERSEDED_MIGRATION_ID));

    // A second run has nothing to do and says so by returning nothing.
    assert.equal(await stripSupersededFields(store, agentDir), null);
  });
});

test("a block-style supersedes list is removed with its items", () => {
  const text = legacyNodeFile("one", {
    supersedes: "\n  - older-one\n  - older-two",
  });

  const rewritten = migrateSupersededFrontMatter(text);

  assert.ok(rewritten !== undefined);
  assert.doesNotMatch(rewritten, /supersedes/u);
  assert.doesNotMatch(rewritten, /older-one/u);
  assert.doesNotMatch(rewritten, /older-two/u);
  // The key that followed the list survives intact.
  assert.match(rewritten, /^links: \[\]$/mu);
  assert.doesNotThrow(() => parseMemoryNode(rewritten, "one"));
});

test("a legacy tombstone moves into history/deleted as a live-looking node", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    await store.writeTextFile(
      "nodes/superseded/old-one.md",
      legacyNodeFile("old-one", {
        status: "superseded",
        decayWeight: "0",
        supersededBy: "replacement",
      }),
    );

    const outcome = await stripSupersededFields(store, agentDir);

    assert.deepEqual(outcome?.changed, ["history/deleted/old-one.md"]);
    assert.equal(
      await store.readTextFileIfExists("nodes/superseded/old-one.md"),
      null,
    );

    const moved = await store.readTextFile("history/deleted/old-one.md");
    assert.match(moved, /^status: active$/mu);
    assert.match(moved, /^decay_weight: 1$/mu);
    assert.doesNotMatch(moved, /superseded/u);
    assert.match(moved, /Body of old-one\./u);

    // It is history now: the strict parser accepts it, and nothing lists it as
    // a canonical memory.
    assert.doesNotThrow(() => parseMemoryNode(moved, "old-one"));
    assert.deepEqual(await repository.list("canonical"), []);
  });
});

test("a tombstone is left alone when its history copy already exists", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const tombstone = legacyNodeFile("old-one", {
      status: "superseded",
      decayWeight: "0",
    });
    await store.writeTextFile("nodes/superseded/old-one.md", tombstone);
    await store.writeTextFile(
      "history/deleted/old-one.md",
      legacyNodeFile("old-one").replace("title: old-one", "title: kept copy"),
    );

    const outcome = await stripSupersededFields(store, agentDir);

    // The existing copy is migrated in place; the tombstone cannot move.
    assert.deepEqual(outcome?.changed, ["history/deleted/old-one.md"]);
    assert.equal(outcome?.skipped.length, 1);
    assert.match(outcome?.skipped[0]?.error ?? "", /already exists/u);
    assert.equal(
      await store.readTextFile("nodes/superseded/old-one.md"),
      tombstone,
    );
    const kept = await store.readTextFile("history/deleted/old-one.md");
    assert.match(kept, /title: kept copy/u);
    assert.doesNotMatch(kept, /^supersedes:/mu);
  });
});

test("a body line beginning with the retired key is never touched", () => {
  const text = legacyNodeFile("one", {
    body: "supersedes: this is prose, not a key.\nsuperseded_by: nor is this.",
  });

  const rewritten = migrateSupersededFrontMatter(text);

  assert.ok(rewritten !== undefined);
  assert.match(rewritten, /^supersedes: this is prose/mu);
  assert.match(rewritten, /^superseded_by: nor is this/mu);
  assert.doesNotMatch(rewritten, /^supersedes: \[\]$/mu);
});

test("a dry run reports the files without writing them", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const original = legacyNodeFile("one");
    await store.writeTextFile("nodes/one.md", original);

    const outcome = await stripSupersededFields(store, agentDir, {
      dryRun: true,
    });

    assert.equal(outcome?.status, "dry-run");
    assert.deepEqual(outcome?.changed, ["nodes/one.md"]);
    assert.equal(await store.readTextFile("nodes/one.md"), original);
    // Nothing was recorded, so the real pass still has work to do.
    assert.notEqual(
      await stripSupersededFields(store, agentDir, { dryRun: true }),
      null,
    );
  });
});

test("a file that cannot be parsed is reported and left alone", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const broken = legacyNodeFile("broken").replace("title: broken\n", "");
    await store.writeTextFile("nodes/broken.md", broken);

    const outcome = await stripSupersededFields(store, agentDir);

    assert.deepEqual(outcome?.changed, []);
    assert.equal(outcome?.skipped.length, 1);
    assert.equal(outcome?.skipped[0]?.path, "nodes/broken.md");
    assert.equal(await store.readTextFile("nodes/broken.md"), broken);
  });
});
