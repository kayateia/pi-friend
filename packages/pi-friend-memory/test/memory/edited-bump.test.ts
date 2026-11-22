/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { listHistoryVersions } from "../../src/memory/history.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import type { MemoryEditInput } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

const START = new Date("2026-11-15T12:00:00.000Z");
const LATER = new Date("2026-11-16T09:00:00.000Z");

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

/** Creates one canonical memory and returns its slug. */
async function makeMemory(service: MemoryNodeService): Promise<string> {
  const node = await service.add({
    title: "Kettle",
    type: "fact",
    body: "The kettle is blue.",
    speaker: [{ name: "Iri", confident: true }],
    tags: ["kitchen"],
    links: [],
    source: "session:start",
  });
  return node.slug;
}

/**
 * Applies one edit at a later time and reports both timestamps.
 *
 * `edited` is optional on the node, so "did not move" is `undefined` on a node
 * that has never had a substantive edit and the earlier value afterwards.
 */
async function editAt(
  agentDir: string,
  input: MemoryEditInput,
): Promise<{ edited: string | undefined; lastUsed: string }> {
  const clock = { now: START };
  const service = await makeService(agentDir, clock);
  const slug = await makeMemory(service);

  clock.now = LATER;
  const node = await service.edit(slug, input);

  return {
    edited: node.frontMatter.edited,
    lastUsed: node.frontMatter.last_used,
  };
}

test("a body edit moves both timestamps", async () => {
  await withTempDir(async (agentDir) => {
    const result = await editAt(agentDir, { body: "The kettle is green." });
    assert.equal(result.edited, LATER.toISOString());
    assert.equal(result.lastUsed, LATER.toISOString());
  });
});

test("a title edit moves both timestamps", async () => {
  await withTempDir(async (agentDir) => {
    const result = await editAt(agentDir, { title: "The blue kettle" });
    assert.equal(result.edited, LATER.toISOString());
    assert.equal(result.lastUsed, LATER.toISOString());
  });
});

test("a speaker edit moves both timestamps", async () => {
  await withTempDir(async (agentDir) => {
    const result = await editAt(agentDir, {
      speaker: [{ name: "Aria", confident: true }],
    });
    assert.equal(result.edited, LATER.toISOString());
    assert.equal(result.lastUsed, LATER.toISOString());
  });
});

test("a confidence change is a speaker edit", async () => {
  await withTempDir(async (agentDir) => {
    const result = await editAt(agentDir, {
      speaker: [{ name: "Iri", confident: false, note: "relayed" }],
    });
    assert.equal(result.edited, LATER.toISOString());
  });
});

test("metadata edits move last_used and leave edited alone", async () => {
  const metadata: MemoryEditInput[] = [
    { tags: ["kitchen", "irrelevant"] },
    { type: "preference" },
    { links: [] },
    { emotionalFlavour: "playful" },
    { agents: ["Airi"] },
    { source: "session:somewhere-else" },
  ];

  for (const input of metadata) {
    await withTempDir(async (agentDir) => {
      const result = await editAt(agentDir, input);
      assert.equal(
        result.edited,
        undefined,
        `${JSON.stringify(input)} must not move edited`,
      );
      assert.equal(result.lastUsed, LATER.toISOString());
    });
  }
});

test("an edit that changes nothing moves only last_used", async () => {
  const unchanged: MemoryEditInput[] = [
    { title: "Kettle" },
    // The stored body is wrapped in newlines; only the content is compared.
    { body: "  The kettle is blue.  " },
    { speaker: [{ name: "Iri", confident: true }] },
    { tags: ["kitchen"] },
  ];

  for (const input of unchanged) {
    await withTempDir(async (agentDir) => {
      const result = await editAt(agentDir, input);
      assert.equal(
        result.edited,
        undefined,
        `${JSON.stringify(input)} is not a change`,
      );
      assert.equal(result.lastUsed, LATER.toISOString());
    });
  }
});

test("a later metadata edit does not erase an earlier edited date", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const slug = await makeMemory(service);

    clock.now = LATER;
    await service.edit(slug, { body: "The kettle is green." });
    clock.now = new Date("2026-11-17T09:00:00.000Z");
    const afterRetag = await service.edit(slug, { tags: ["kitchen", "green"] });

    assert.equal(afterRetag.frontMatter.edited, LATER.toISOString());
    assert.equal(
      afterRetag.frontMatter.last_used,
      "2026-11-17T09:00:00.000Z",
    );
  });
});

test("every edit archives the version it replaced, metadata or not", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const service = await makeService(agentDir, clock);
    const slug = await makeMemory(service);

    clock.now = LATER;
    await service.edit(slug, { tags: ["kitchen", "irrelevant"] });

    const versions = await listHistoryVersions(
      service.store,
      "edited",
      slug,
    );
    assert.deepEqual(versions, [
      `history/edited/${slug}/${LATER.toISOString()}.md`,
    ]);
  });
});
