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
  STAGING_EDITED_MIGRATION_ID,
  migrationsPath,
  removeEditedKey,
  stripCandidateEditedFields,
} from "../../src/memory/migrations.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { parseMemoryNodeFile } from "../../src/memory/schema.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

/** A staging file, with or without the field this item removes. */
function candidateFile(
  slug: string,
  options: { edited?: string; body?: string } = {},
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
status: candidate
emotional_flavour: neutral
tags: []
links: []
sources: []
${options.edited === undefined ? "" : `edited: ${options.edited}\n`}---

${options.body ?? `Body of ${slug}.`}
`;
}

test("a staging candidate carrying edited is refused", () => {
  const text = candidateFile("draft", { edited: "2026-11-01T00:00:00.000Z" });

  assert.throws(
    () =>
      parseMemoryNodeFile(text, {
        kind: "staging-candidate",
        relativePath: "staging/draft.md",
      }),
    /"edited" must be absent from front matter for staging node draft/u,
  );
});

test("a canonical memory may still carry edited", () => {
  const text = candidateFile("kept", { edited: "2026-11-01T00:00:00.000Z" })
    .replace("status: candidate", "status: active");

  const node = parseMemoryNodeFile(text, {
    kind: "node",
    relativePath: "nodes/kept.md",
  });
  assert.equal(node.frontMatter.edited, "2026-11-01T00:00:00.000Z");
});

test("restoring a dropped candidate leaves no edited timestamp", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-11-15T12:00:00.000Z"),
    );

    const staged = await service.stageCandidate({
      title: "Draft",
      type: "fact",
      body: "A candidate.",
      speaker: [],
    });
    await service.delete(staged.node.slug);

    // Make the archived copy look like one an older build wrote, which is the
    // only way a restore could return a candidate carrying the field.
    const archived = `history/dropped/${staged.node.slug}.md`;
    const text = await repository.store.readTextFile(archived);
    await repository.store.writeTextFile(
      archived,
      text.replace(
        "\n---\n",
        // Later than the candidate\'s own creation, which the schema requires.
        "\nedited: 2026-11-16T00:00:00.000Z\n---\n",
      ),
    );

    const restored = await service.restore(staged.node.slug);

    assert.equal(restored.restoredTo, "staging");
    assert.equal(restored.node.frontMatter.edited, undefined);
    const stored = await service.read(staged.node.slug, "staging");
    assert.equal(stored?.frontMatter.edited, undefined);
    assert.equal(stored?.frontMatter.status, "candidate");
  });
});

test("the migration removes edited from staging and records itself", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;

    await store.writeTextFile(
      "staging/draft.md",
      candidateFile("draft", { edited: "2026-11-01T00:00:00.000Z" }),
    );
    await store.writeTextFile("staging/clean.md", candidateFile("clean"));

    const outcome = await stripCandidateEditedFields(store, agentDir);

    assert.equal(outcome?.status, "applied");
    assert.deepEqual(outcome?.changed, ["staging/draft.md"]);
    assert.deepEqual(outcome?.skipped, []);

    const text = await store.readTextFile("staging/draft.md");
    assert.doesNotMatch(text, /^edited:/mu);
    assert.match(text, /Body of draft\./u);

    // The listing the sweep uses now parses the file again.
    const candidates = await repository.list("staging");
    assert.deepEqual(candidates.map((node) => node.slug).sort(), [
      "clean",
      "draft",
    ]);

    const record = JSON.parse(
      await readFile(migrationsPath(agentDir), "utf8"),
    ) as { applied: string[] };
    assert.ok(record.applied.includes(STAGING_EDITED_MIGRATION_ID));

    // A second run has nothing to do and says so by returning nothing.
    assert.equal(await stripCandidateEditedFields(store, agentDir), null);
  });
});

test("a dry run reports the files without writing them", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;
    const original = candidateFile("draft", {
      edited: "2026-11-01T00:00:00.000Z",
    });
    await store.writeTextFile("staging/draft.md", original);

    const outcome = await stripCandidateEditedFields(store, agentDir, {
      dryRun: true,
    });

    assert.equal(outcome?.status, "dry-run");
    assert.deepEqual(outcome?.changed, ["staging/draft.md"]);
    assert.equal(await store.readTextFile("staging/draft.md"), original);
    // Nothing was recorded, so the real pass still has work to do.
    assert.notEqual(
      await stripCandidateEditedFields(store, agentDir, { dryRun: true }),
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
    const broken = candidateFile("broken", {
      edited: "2026-11-01T00:00:00.000Z",
    }).replace("title: broken\n", "");
    await store.writeTextFile("staging/broken.md", broken);

    const outcome = await stripCandidateEditedFields(store, agentDir);

    assert.deepEqual(outcome?.changed, []);
    assert.equal(outcome?.skipped.length, 1);
    assert.equal(await store.readTextFile("staging/broken.md"), broken);
  });
});

test("a body line beginning with edited: is not a front-matter key", () => {
  const text = candidateFile("prose", { body: "edited: this is prose" });

  assert.equal(removeEditedKey(text), undefined);
});
