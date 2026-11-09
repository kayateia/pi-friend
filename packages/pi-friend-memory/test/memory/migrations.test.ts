/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  FLAVOUR_MIGRATION_ID,
  migrationsPath,
  runPendingMigrations,
} from "../../src/memory/migrations.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { withTempDir } from "../helpers.ts";

/** A node file as the previous release wrote it: USian key, otherwise valid. */
function legacyNode(slug: string, flavour = "warm"): string {
  return `---
title: ${slug}
type: fact
speaker:
  - name: Aisling
    confident: true
agents: []
created: 2026-10-01T00:00:00Z
last_used: 2026-10-01T00:00:00Z
use_count: 0
decay_weight: 1
status: active
emotional_flavor: ${flavour}
tags: []
supersedes: []
superseded_by: ""
links: []
source: ""
---

Body of ${slug}.
`;
}

/** Opens a repository in a temporary agent directory. */
async function makeRepository(agentDir: string): Promise<MemoryNodeRepository> {
  return MemoryNodeRepository.open({ agentDir, homeDir: agentDir });
}

test("the flavour rename rewrites live memories, candidates and history", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await makeRepository(agentDir);
    const store = repository.store;

    await store.writeTextFile("nodes/kitchen.md", legacyNode("kitchen"));
    await store.writeTextFile("staging/draft.md", legacyNode("draft", "sore"));
    await store.writeTextFile(
      "history/edited/kitchen/2026-10-02T00:00:00.000Z.md",
      `${legacyNode("kitchen").replace(
        "source: \"\"",
        "source: \"\"\nhistory_reason: \"tidy up\"",
      )}`,
    );

    const outcome = await runPendingMigrations(store, agentDir);
    assert.equal(outcome?.status, "applied");
    assert.equal(outcome?.changed.length, 3);

    for (const file of ["nodes/kitchen.md", "staging/draft.md"]) {
      const text = await store.readTextFile(file);
      assert.match(text, /emotional_flavour:/u);
      assert.doesNotMatch(text, /emotional_flavor:/u);
    }

    // A history entry keeps the field that says why it was kept.
    const version = await store.readTextFile(
      "history/edited/kitchen/2026-10-02T00:00:00.000Z.md",
    );
    assert.match(version, /emotional_flavour: warm/u);
    assert.match(version, /history_reason: "tidy up"/u);

    // The record says which migration ran, and where the copy went.
    const state = JSON.parse(await readFile(migrationsPath(agentDir), "utf8"));
    assert.deepEqual(state.applied, [FLAVOUR_MIGRATION_ID]);
    assert.ok(state.backups[FLAVOUR_MIGRATION_ID]);
  });
});

test("a second run retires the backup once the store parses cleanly", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await makeRepository(agentDir);
    const store = repository.store;
    await store.writeTextFile("nodes/kitchen.md", legacyNode("kitchen"));

    await runPendingMigrations(store, agentDir);

    const backup = JSON.parse(
      await readFile(migrationsPath(agentDir), "utf8"),
    ).backups[FLAVOUR_MIGRATION_ID];
    assert.ok((await readdir(path.join(backup, "files", "nodes"))).length > 0);

    const second = await runPendingMigrations(store, agentDir);
    assert.equal(second?.status, "retired-backup");
    await assert.rejects(async () => readdir(backup));

    // Nothing left to do on a third start.
    assert.equal(await runPendingMigrations(store, agentDir), null);
  });
});

test("a file that cannot be parsed is reported and left untouched", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await makeRepository(agentDir);
    const store = repository.store;
    await store.writeTextFile("nodes/broken.md", legacyNode("broken").replace("status: active", "status: nonsense"));

    const outcome = await runPendingMigrations(store, agentDir);
    assert.equal(outcome?.changed.length, 0);
    assert.equal(outcome?.skipped.length, 1);
    assert.match(outcome?.skipped[0]?.error ?? "", /status/u);

    // The original text survives, key and all, so a repair has something to work
    // from.
    const text = await store.readTextFile("nodes/broken.md");
    assert.match(text, /emotional_flavor: warm/u);
  });
});

test("the rewrite touches the key, not the word, and only in front matter", async () => {
  const { renameFlavourKey } = await import("../../src/memory/migrations.ts");
  const text = [
    "---",
    "title: kitchen",
    "emotional_flavor: warm",
    "tags: []",
    "---",
    "",
    "The emotional_flavor: field appears in this body on purpose.",
    "",
  ].join("\n");

  const rewritten = renameFlavourKey(text);
  assert.equal(
    rewritten,
    text.replace("emotional_flavor: warm", "emotional_flavour: warm"),
  );
  assert.match(rewritten ?? "", /The emotional_flavor: field appears/u);
  assert.equal(renameFlavourKey("no front matter here\n"), undefined);
});

test("a store with nothing to migrate is marked without a message", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await makeRepository(agentDir);
    const store = repository.store;
    await store.writeTextFile(
      "nodes/kitchen.md",
      legacyNode("kitchen").replace("emotional_flavor", "emotional_flavour"),
    );

    const outcome = await runPendingMigrations(store, agentDir);
    assert.equal(outcome?.status, "applied");
    assert.deepEqual(outcome?.changed, []);
    assert.deepEqual(outcome?.skipped, []);
  });
});

test("a store that stops parsing keeps the backup instead of retiring it", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await makeRepository(agentDir);
    const store = repository.store;
    await store.writeTextFile("nodes/kitchen.md", legacyNode("kitchen"));
    await runPendingMigrations(store, agentDir);

    const state = JSON.parse(await readFile(migrationsPath(agentDir), "utf8"));
    const backup = state.backups[FLAVOUR_MIGRATION_ID] as string;

    // Something damages a node after the migration, before the retirement pass.
    await store.writeTextFile(
      "nodes/damaged.md",
      (await store.readTextFile("nodes/kitchen.md")).replace(
        "status: active",
        "status: nonsense",
      ),
    );

    const second = await runPendingMigrations(store, agentDir);
    assert.equal(second?.status, "already-applied");
    assert.equal(second?.skipped.length, 1);
    assert.equal(second?.backupPath, backup);
    // The copy is still there, because the store has not proved itself.
    assert.ok((await readdir(path.join(backup, "files", "nodes"))).length > 0);
  });
});
