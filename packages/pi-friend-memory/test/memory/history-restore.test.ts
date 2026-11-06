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
  readHistoryEntry,
  versionTimestamp,
  writeHistoryEntry,
} from "../../src/memory/history.ts";
import type { ParsedMemoryNode } from "../../src/memory/schema.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

const FIXED_TIME = new Date("2026-10-19T20:00:00.000Z");

/** Creates a service and its repository over an isolated memory tree. */
async function makeService(
  agentDir: string,
  now: () => Date = () => FIXED_TIME,
): Promise<{ service: MemoryNodeService; repository: MemoryNodeRepository }> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return { service: new MemoryNodeService(repository, now), repository };
}

test("a merge stores both sides before rewriting the target", async () => {
  await withTempDir(async (agentDir) => {
    const { service, repository } = await makeService(agentDir);
    const target = await service.add({
      title: "Merge Target",
      type: "fact",
      body: "The target said this first.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const staged = await service.stageCandidate({
      title: "Merge Candidate",
      type: "fact",
      body: "The candidate said this instead.",
      speaker: [{ name: "Aria", confident: true }],
    });

    const result = await service.promoteCandidate(
      staged.node.slug,
      target.slug,
      { conflict: "The two accounts disagree about who said it." },
    );
    assert.equal(result.merged, true);

    const store = repository.store;
    const targetPaths = await store.listDirectoryMarkdown(
      `history/merged/${target.slug}`,
    );
    assert.equal(targetPaths.length, 1);
    const targetEntry = await readHistoryEntry(
      store,
      targetPaths[0] ?? "",
      target.slug,
    );
    assert.ok(targetEntry);
    assert.match(targetEntry.body, /The target said this first\./);
    assert.doesNotMatch(targetEntry.body, /The candidate said this instead\./);
    assert.equal(
      targetEntry.frontMatter.history_conflict,
      "The two accounts disagree about who said it.",
    );

    const candidatePaths = await store.listDirectoryMarkdown(
      `history/merged/${staged.node.slug}`,
    );
    assert.equal(candidatePaths.length, 1);
    const candidateEntry = await readHistoryEntry(
      store,
      candidatePaths[0] ?? "",
      staged.node.slug,
    );
    assert.ok(candidateEntry);
    // The candidate was still a staging candidate when it was archived.
    assert.equal(candidateEntry.frontMatter.status, "candidate");
    assert.match(candidateEntry.body, /The candidate said this instead\./);
  });
});

test("restoring a merged version puts the pre-merge body back", async () => {
  await withTempDir(async (agentDir) => {
    const { service, repository } = await makeService(agentDir);
    const target = await service.add({
      title: "Undo Merge",
      type: "fact",
      body: "Only the target's text.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const staged = await service.stageCandidate({
      title: "Added Text",
      type: "fact",
      body: "Text that arrived in a merge.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.promoteCandidate(staged.node.slug, target.slug);

    const merged = await service.read(target.slug);
    assert.ok(merged);
    assert.match(merged.body, /Text that arrived in a merge\./);

    const [versionPath] = await repository.store.listDirectoryMarkdown(
      `history/merged/${target.slug}`,
    );
    assert.ok(versionPath);

    const restored = await service.restore(
      target.slug,
      versionTimestamp(versionPath),
    );
    assert.equal(restored.replaced, true);
    assert.match(restored.restoredFrom, /^history\/merged\//u);
    assert.match(restored.node.body, /Only the target's text\./);
    assert.doesNotMatch(restored.node.body, /Text that arrived in a merge\./);

    // The merged text is not lost: it became a version of the same memory.
    const versions = await repository.store.listDirectoryMarkdown(
      `history/edited/${target.slug}`,
    );
    const displaced = await readHistoryEntry(
      repository.store,
      versions[0] ?? "",
      target.slug,
    );
    assert.ok(displaced);
    assert.match(displaced.body, /Text that arrived in a merge\./);
    assert.equal(
      displaced.frontMatter.history_reason,
      "replaced by memory_restore",
    );
  });
});

test("restoring a split source removes the children it recorded", async () => {
  await withTempDir(async (agentDir) => {
    const { service, repository } = await makeService(agentDir);
    const source: ParsedMemoryNode = await service.add({
      title: "Split Source",
      type: "fact",
      body: "Two facts that will be separated.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const firstChild = await service.add({
      title: "First Half",
      type: "fact",
      body: "The first fact alone.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const secondChild = await service.add({
      title: "Second Half",
      type: "fact",
      body: "The second fact alone.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    // No split operation exists yet, so the entry is written the way a future
    // one would: the source as it was, with the children it produced.
    const timestamp = "2026-11-05T09:00:00.000Z";
    await writeHistoryEntry(repository.store, {
      kind: "split",
      slug: source.slug,
      timestamp,
      node: {
        slug: source.slug,
        frontMatter: {
          ...source.frontMatter,
          history_children: [firstChild.slug, secondChild.slug],
        },
        body: source.body,
      },
    });
    await repository.remove(source.slug, "canonical");

    const restored = await service.restore(source.slug, timestamp);
    assert.deepEqual(restored.removedChildren, [
      firstChild.slug,
      secondChild.slug,
    ]);
    assert.deepEqual(restored.missingChildren, []);
    assert.equal(restored.replaced, false);
    assert.equal(restored.node.frontMatter.history_children, undefined);
    assert.match(restored.node.body, /Two facts that will be separated\./);

    assert.equal(await service.read(firstChild.slug), null);
    assert.equal(await service.read(secondChild.slug), null);
    assert.ok(await service.read(source.slug));
  });
});

test("a split child that was already removed is reported, not fatal", async () => {
  await withTempDir(async (agentDir) => {
    const { service, repository } = await makeService(agentDir);
    const source = await service.add({
      title: "Half Split",
      type: "fact",
      body: "Only one child survived.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const survivor = await service.add({
      title: "Survivor",
      type: "fact",
      body: "Still here.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const timestamp = "2026-11-05T09:10:00.000Z";
    await writeHistoryEntry(repository.store, {
      kind: "split",
      slug: source.slug,
      timestamp,
      node: {
        slug: source.slug,
        frontMatter: {
          ...source.frontMatter,
          history_children: [survivor.slug, "deleted-long-ago"],
        },
        body: source.body,
      },
    });
    await repository.remove(source.slug, "canonical");

    const restored = await service.restore(source.slug, timestamp);
    assert.deepEqual(restored.removedChildren, [survivor.slug]);
    assert.deepEqual(restored.missingChildren, ["deleted-long-ago"]);
  });
});

test("a dropped candidate comes back into staging, not nodes", async () => {
  await withTempDir(async (agentDir) => {
    const { service, repository } = await makeService(agentDir);
    const staged = await service.stageCandidate({
      title: "Dropped Candidate",
      type: "fact",
      body: "A candidate a sweep decided to drop.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.archiveCandidate(staged.node.slug);
    assert.equal(await service.read(staged.node.slug, "staging"), null);

    const restored = await service.restore(staged.node.slug);
    assert.equal(restored.restoredTo, "staging");
    assert.equal(restored.replaced, false);
    assert.match(restored.restoredFrom, /^history\/dropped\//u);

    const back = await service.read(staged.node.slug, "staging");
    assert.ok(back);
    assert.equal(back.frontMatter.status, "candidate");
    assert.match(back.body, /A candidate a sweep decided to drop\./);
    assert.equal(await service.read(staged.node.slug), null);
    // The entry is consumed, so it is not restored twice.
    await assert.rejects(
      () => service.restore(staged.node.slug),
      /No deleted memory or stored version named/,
    );
    assert.deepEqual(
      await repository.store.listDirectoryMarkdown("history/dropped"),
      [],
    );
  });
});

test("a dropped candidate is not allowed to replace a canonical memory", async () => {
  await withTempDir(async (agentDir) => {
    const { service } = await makeService(agentDir);
    const staged = await service.stageCandidate({
      title: "Same Name",
      type: "fact",
      body: "Candidate text.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.archiveCandidate(staged.node.slug);
    await service.add({
      slug: staged.node.slug,
      title: "Same Name",
      type: "fact",
      body: "Canonical text.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    await assert.rejects(
      () => service.restore(staged.node.slug),
      /canonical memory with that slug exists/u,
    );
    assert.match(
      (await service.read(staged.node.slug))?.body ?? "",
      /Canonical text\./,
    );
  });
});
