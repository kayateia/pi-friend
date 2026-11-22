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
import { withTempDir } from "../helpers.ts";

const START = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;

/**
 * Retention has to read the same clock the operation writes with.
 *
 * The version timestamps an edit produces come from the service's `now`. When
 * pruning read the wall clock instead, an edit made under a fixture clock wrote
 * a version and deleted it in the same call — the test suite skipped forward
 * thirty days and five history tests started failing without any code changing.
 */
test("an edit keeps the version it just wrote, whatever today is", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository, () => clock.now);
    const created = await service.add({
      title: "Kettle",
      type: "fact",
      body: "The kettle is blue.",
      speaker: [],
    });

    const edited = await service.edit(created.slug, { body: "Green." });

    const versions = await listHistoryVersions(
      service.store,
      "edited",
      created.slug,
    );
    assert.deepEqual(versions, [
      `history/edited/${created.slug}/${START.toISOString()}.md`,
    ]);
    assert.equal(edited.frontMatter.edited, START.toISOString());
  });
});

test("retention still prunes a version older than the keep window", async () => {
  await withTempDir(async (agentDir) => {
    const clock = { now: START };
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository, () => clock.now);
    const created = await service.add({
      title: "Kettle",
      type: "fact",
      body: "The kettle is blue.",
      speaker: [],
    });

    await service.edit(created.slug, { body: "Green." });

    // Forty days later the first version is outside the thirty-day window and
    // the second one is not, so exactly one should survive.
    clock.now = new Date(START.getTime() + 40 * DAY);
    const second = await service.edit(created.slug, { body: "Chipped." });

    const versions = await listHistoryVersions(
      service.store,
      "edited",
      created.slug,
    );
    assert.deepEqual(versions, [
      `history/edited/${created.slug}/${clock.now.toISOString()}.md`,
    ]);
    assert.equal(second.body, "\nChipped.\n");
  });
});
