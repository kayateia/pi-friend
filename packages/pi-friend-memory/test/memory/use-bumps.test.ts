/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

const START = new Date("2026-11-15T12:00:00.000Z");

/** Opens a service whose clock the test can move. */
async function makeService(
  agentDir: string,
  clock: { now: Date },
): Promise<MemoryNodeService> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return new MemoryNodeService(repository, () => clock.now);
}

/** Creates one canonical memory to bump. */
async function makeMemory(
  service: MemoryNodeService,
): Promise<string> {
  const node = await service.add({
    title: "Kettle",
    type: "fact",
    body: "The kettle is blue.",
    speaker: [{ name: "Iri", confident: true }],
  });
  return node.slug;
}

test("a new memory starts unused", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir, { now: START });
    const node = await service.read(await makeMemory(service));

    assert.equal(node?.frontMatter.use_count, 0);
    assert.equal(node?.frontMatter.last_used, START.toISOString());
    assert.equal(node?.frontMatter.edited, undefined);
  });
});

test("a use moves last_used and use_count, and nothing else", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const slug = await makeMemory(service);

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    await service.recordUse([slug]);

    const node = await service.read(slug);
    assert.equal(node?.frontMatter.last_used, "2026-11-16T09:00:00.000Z");
    assert.equal(node?.frontMatter.use_count, 1);
    // A use is attention, not authorship: the content timestamp must not move,
    // because the sync and the recency ordering both read it.
    assert.equal(node?.frontMatter.edited, undefined);
    assert.equal(node?.frontMatter.decay_weight, 1);
    assert.equal(node?.frontMatter.created, START.toISOString());
    assert.equal(node?.body, "\nThe kettle is blue.\n");
  });
});

test("one node used twice in one call counts once", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const slug = await makeMemory(service);

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    await service.recordUse([slug, slug, slug]);

    const node = await service.read(slug);
    assert.equal(node?.frontMatter.use_count, 1);
  });
});

test("a use leaves an existing edited timestamp where it was", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const slug = await makeMemory(service);

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    await service.edit(slug, { body: "The kettle is green." });

    clock.now = new Date("2026-11-17T09:00:00.000Z");
    await service.recordUse([slug]);

    const node = await service.read(slug);
    assert.equal(node?.frontMatter.edited, "2026-11-16T09:00:00.000Z");
    assert.equal(node?.frontMatter.last_used, "2026-11-17T09:00:00.000Z");
    assert.equal(node?.frontMatter.use_count, 1);
  });
});

test("candidates and unknown slugs are not bumped", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);

    const staged = await service.stageCandidate({
      title: "Candidate",
      type: "fact",
      body: "A draft.",
      speaker: [],
    });

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    // A candidate's decay deliberately ignores retrieval, so bumping one would
    // keep whatever a retriever likes from ever expiring.
    await service.recordUse([staged.node.slug, "no-such-memory"]);

    const candidate = await service.read(staged.node.slug, "staging");
    assert.equal(candidate?.frontMatter.use_count, 0);
    assert.equal(candidate?.frontMatter.last_used, START.toISOString());
  });
});

test("an edit is a use for freshness but not for the read count", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const slug = await makeMemory(service);

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    const edited = await service.edit(slug, { body: "The kettle is red." });

    assert.equal(edited.frontMatter.edited, "2026-11-16T09:00:00.000Z");
    assert.equal(edited.frontMatter.last_used, "2026-11-16T09:00:00.000Z");
    assert.equal(edited.frontMatter.use_count, 0);
  });
});

test("a merge moves the target's last_used and leaves its count alone", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const target = await makeMemory(service);
    const source = await service.add({
      title: "Second account",
      type: "fact",
      body: "It is blue, as far as I know.",
      speaker: [],
    });

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    const result = await service.mergeCandidates(target, [source.slug]);

    assert.equal(result.node.frontMatter.last_used, "2026-11-16T09:00:00.000Z");
    assert.equal(result.node.frontMatter.edited, "2026-11-16T09:00:00.000Z");
    assert.equal(result.node.frontMatter.use_count, 0);
  });
});

test("promotion moves last_used and leaves the count alone", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const staged = await service.stageCandidate({
      title: "Candidate",
      type: "fact",
      body: "A draft.",
      speaker: [],
    });

    clock.now = new Date("2026-11-16T09:00:00.000Z");
    const promoted = await service.promoteCandidate(staged.node.slug);

    // Promotion is a use for freshness — the candidate was adopted — but it is
    // not a read, and `use_count` counts reads.
    assert.equal(promoted.node.frontMatter.use_count, 0);
    assert.equal(
      promoted.node.frontMatter.last_used,
      "2026-11-16T09:00:00.000Z",
    );
  });
});
