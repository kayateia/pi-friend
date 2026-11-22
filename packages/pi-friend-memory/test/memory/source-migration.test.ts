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
  SOURCE_FIELD_MIGRATION_ID,
  convertSourceField,
  convertSourceFrontMatter,
  migrationsPath,
} from "../../src/memory/migrations.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { parseMemoryNode } from "../../src/memory/schema.ts";
import { withTempDir } from "../helpers.ts";

/** A node file in the pre-migration shape, with one legacy `source` value. */
function legacyNodeFile(
  slug: string,
  source: string,
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
links: []
source: ${source}
---

Body of ${slug}.
`;
}

test("an empty source becomes an empty array", () => {
  const rewritten = convertSourceFrontMatter(legacyNodeFile("one", '""'));

  assert.ok(rewritten !== undefined);
  assert.match(rewritten, /^sources: \[\]$/mu);
  assert.doesNotMatch(rewritten, /^source:/mu);
  assert.doesNotThrow(() => parseMemoryNode(rewritten, "one"));
});

test("a session source becomes a session record", () => {
  const rewritten = convertSourceFrontMatter(
    legacyNodeFile("one", "session:01a1b2c3"),
  );

  assert.ok(rewritten !== undefined);
  assert.match(rewritten, /sources:\n {2}- action: "add"\n {4}sessionId: "01a1b2c3"/u);
  const node = parseMemoryNode(rewritten, "one");
  assert.deepEqual(node.frontMatter.sources, [
    { action: "add", sessionId: "01a1b2c3" },
  ]);
});

test("a sweep source becomes a sweep record", () => {
  const rewritten = convertSourceFrontMatter(
    legacyNodeFile("one", '"sweep:run-42"'),
  );

  assert.ok(rewritten !== undefined);
  const node = parseMemoryNode(rewritten, "one");
  assert.deepEqual(node.frontMatter.sources, [
    { action: "add", sweepRunId: "run-42" },
  ]);
});

test("free text is preserved under other, quoted", () => {
  const value = "conversation 2026-11-02: the kettle thread";
  const rewritten = convertSourceFrontMatter(
    legacyNodeFile("one", `"${value}"`),
  );

  assert.ok(rewritten !== undefined);
  const node = parseMemoryNode(rewritten, "one");
  assert.deepEqual(node.frontMatter.sources, [{ action: "add", other: value }]);
});

test("a body line beginning with source is never touched", () => {
  const text = legacyNodeFile("one", '""').replace(
    "Body of one.",
    "source: this is prose, not a key.",
  );

  const rewritten = convertSourceFrontMatter(text);

  assert.ok(rewritten !== undefined);
  assert.match(rewritten, /^source: this is prose/mu);
});

test("the migration converts nodes, staging and history", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;

    await store.writeTextFile(
      "nodes/one.md",
      legacyNodeFile("one", "session:01a1b2c3"),
    );
    await store.writeTextFile(
      "staging/draft.md",
      legacyNodeFile("draft", '""', "candidate"),
    );
    await store.writeTextFile(
      "history/deleted/gone.md",
      legacyNodeFile("gone", '"conversation 2026-10-01"'),
    );

    const outcome = await convertSourceField(store, agentDir);

    assert.equal(outcome?.status, "applied");
    assert.deepEqual(outcome?.changed.sort(), [
      "history/deleted/gone.md",
      "nodes/one.md",
      "staging/draft.md",
    ]);
    assert.deepEqual(outcome?.skipped, []);

    for (const path of [
      "nodes/one.md",
      "staging/draft.md",
      "history/deleted/gone.md",
    ]) {
      const text = await store.readTextFile(path);
      assert.doesNotMatch(text, /^source:/mu, path);
      assert.match(text, /^sources:/mu, path);
    }

    // Every area parses again, which is why the pass runs before anything else.
    assert.deepEqual(
      (await repository.list("canonical")).map((node) => node.slug),
      ["one"],
    );
    assert.deepEqual(
      (await repository.list("staging")).map((node) => node.slug),
      ["draft"],
    );

    const record = JSON.parse(
      await readFile(migrationsPath(agentDir), "utf8"),
    ) as { applied: string[] };
    assert.ok(record.applied.includes(SOURCE_FIELD_MIGRATION_ID));

    assert.equal(await convertSourceField(store, agentDir), null);
  });
});

test("a dry run reports the files without writing them", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const original = legacyNodeFile("one", "session:01a1b2c3");
    await store.writeTextFile("nodes/one.md", original);

    const outcome = await convertSourceField(store, agentDir, { dryRun: true });

    assert.equal(outcome?.status, "dry-run");
    assert.deepEqual(outcome?.changed, ["nodes/one.md"]);
    assert.equal(await store.readTextFile("nodes/one.md"), original);
  });
});

test("a file that cannot be parsed is reported and left alone", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const broken = legacyNodeFile("broken", "session:01a1b2c3").replace(
      "title: broken\n",
      "",
    );
    await store.writeTextFile("nodes/broken.md", broken);

    const outcome = await convertSourceField(store, agentDir);

    assert.deepEqual(outcome?.changed, []);
    assert.equal(outcome?.skipped.length, 1);
    assert.equal(await store.readTextFile("nodes/broken.md"), broken);
  });
});
