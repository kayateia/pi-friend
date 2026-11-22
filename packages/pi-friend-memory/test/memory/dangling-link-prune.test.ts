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
  DANGLING_LINKS_MIGRATION_ID,
  migrationsPath,
  pruneDanglingLinks,
} from "../../src/memory/migrations.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { parseMemoryNode } from "../../src/memory/schema.ts";
import { validateLinks } from "../../src/memory/validation.ts";
import { withTempDir } from "../helpers.ts";

/** A node file with the given links and status. */
function nodeFile(
  slug: string,
  links: readonly string[],
  status = "active",
): string {
  return `---
title: ${slug}
type: fact
speaker: []
agents: []
created: 2026-10-01T00:00:00Z
last_used: 2026-10-01T00:00:00Z
use_count: 0
decay_weight: 1
status: ${status}
emotional_flavour: neutral
tags: []
links:${links.length === 0 ? " []" : `\n${links.map((link) => `  - ${link}`).join("\n")}`}
sources: []
---

Body of ${slug}.
`;
}

test("dead links are removed from live memories and kept in history", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;

    await store.writeTextFile("nodes/target.md", nodeFile("target", []));
    await store.writeTextFile(
      "nodes/observer.md",
      nodeFile("observer", ["target", "gone-memory"]),
    );
    await store.writeTextFile(
      "staging/draft.md",
      nodeFile("draft", ["target", "vanished"], "candidate"),
    );
    // A snapshot of a node as it was: the link it pointed at then may be gone,
    // and removing it would make the entry a record of something that did not
    // happen.
    await store.writeTextFile(
      "history/deleted/old.md",
      nodeFile("old", ["gone-memory"]),
    );

    const outcome = await pruneDanglingLinks(store, agentDir);

    assert.equal(outcome?.status, "applied");
    assert.deepEqual(outcome?.changed.sort(), [
      "nodes/observer.md",
      "staging/draft.md",
    ]);
    assert.deepEqual(outcome?.skipped, []);

    const observer = parseMemoryNode(
      await store.readTextFile("nodes/observer.md"),
      "observer",
    );
    assert.deepEqual(observer.frontMatter.links, ["target"]);

    const draft = parseMemoryNode(
      await store.readTextFile("staging/draft.md"),
      "draft",
    );
    assert.deepEqual(draft.frontMatter.links, ["target"]);

    const history = await store.readTextFile("history/deleted/old.md");
    assert.match(history, /gone-memory/u);

    // The store is clean as far as the link check is concerned.
    assert.deepEqual(await validateLinks(store), []);

    const record = JSON.parse(
      await readFile(migrationsPath(agentDir), "utf8"),
    ) as { applied: string[] };
    assert.ok(record.applied.includes(DANGLING_LINKS_MIGRATION_ID));

    assert.equal(await pruneDanglingLinks(store, agentDir), null);
  });
});

test("a self-link is removed like any other dead pointer", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    await store.writeTextFile("nodes/loop.md", nodeFile("loop", ["loop"]));

    const outcome = await pruneDanglingLinks(store, agentDir);

    assert.deepEqual(outcome?.changed, ["nodes/loop.md"]);
    const node = parseMemoryNode(
      await store.readTextFile("nodes/loop.md"),
      "loop",
    );
    assert.deepEqual(node.frontMatter.links, []);
  });
});

test("a dry run reports the files without writing them", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const original = nodeFile("observer", ["gone-memory"]);
    await store.writeTextFile("nodes/observer.md", original);

    const outcome = await pruneDanglingLinks(store, agentDir, { dryRun: true });

    assert.equal(outcome?.status, "dry-run");
    assert.deepEqual(outcome?.changed, ["nodes/observer.md"]);
    assert.equal(await store.readTextFile("nodes/observer.md"), original);
    // Nothing was recorded, so the real pass still has work to do.
    assert.notEqual(await pruneDanglingLinks(store, agentDir, { dryRun: true }), null);
  });
});
