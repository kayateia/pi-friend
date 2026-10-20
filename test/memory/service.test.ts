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
import {
  MemoryNodeService,
  MemoryServiceError,
  slugifyTitle,
} from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

const FIXED_TIME = new Date("2026-10-19T20:00:00.000Z");

/** Creates a service backed by an isolated memory tree. */
async function makeService(
  agentDir: string,
  now: () => Date = () => FIXED_TIME,
): Promise<MemoryNodeService> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return new MemoryNodeService(repository, now);
}

test("titles become safe lowercase slugs", () => {
  assert.equal(slugifyTitle("Café & Warmth"), "cafe-warmth");
  assert.equal(slugifyTitle("  A / B  "), "a-b");
  assert.equal(slugifyTitle("💛"), "memory");
});

test("add creates an active node with schema defaults", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const node = await service.add({
      title: "A Warm Memory",
      type: "fact",
      body: "The kitchen window faces east.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    assert.equal(node.slug, "a-warm-memory");
    assert.equal(node.body, "\nThe kitchen window faces east.\n");
    assert.equal(node.frontMatter.created, FIXED_TIME.toISOString());
    assert.equal(node.frontMatter.last_used, FIXED_TIME.toISOString());
    assert.equal(node.frontMatter.status, "active");
    assert.equal(node.frontMatter.decay_weight, 1);
    assert.equal(node.frontMatter.emotional_flavor, "neutral");
    assert.deepEqual(await service.read(node.slug), node);
  });
});

test("automatic slugs gain a deterministic suffix on collision", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const input = {
      title: "Same Title",
      type: "event" as const,
      body: "One event.",
      speaker: [{ name: "Aisling", confident: true }],
    };

    const first = await service.add(input);
    const second = await service.add(input);
    const third = await service.add(input);

    assert.equal(first.slug, "same-title");
    assert.equal(second.slug, "same-title-2");
    assert.equal(third.slug, "same-title-3");
  });
});

test("explicit slug collisions fail instead of overwriting", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const input = {
      title: "Explicit",
      type: "preference" as const,
      body: "Explicit slug.",
      speaker: [{ name: "Aisling", confident: true }],
      slug: "chosen-slug",
    };

    await service.add(input);
    await assert.rejects(
      () => service.add(input),
      MemoryServiceError,
    );
  });
});

test("read returns null for missing nodes", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    assert.equal(await service.read("missing"), null);
  });
});

test("schema validation remains active through the service", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () =>
        service.add({
          title: "Broken Link",
          type: "fact",
          body: "Body.",
          speaker: [{ name: "Aisling", confident: true }],
          links: ["Invalid Slug"],
        }),
      /Invalid slug/,
    );
  });
});

test("edit preserves creation state and appends an audit entry", async () => {
  await withTempDir(async (agentDir) => {
    let currentTime = FIXED_TIME;
    const service = await makeService(agentDir, () => currentTime);
    const created = await service.add({
      title: "Original Title",
      type: "fact",
      body: "Original body.",
      speaker: [{ name: "Aisling", confident: true }],
      tags: ["old"],
    });

    currentTime = new Date("2026-10-19T21:00:00.000Z");
    const edited = await service.edit(created.slug, {
      title: "Updated Title",
      body: "Updated body.",
      tags: ["new"],
      reason: "Corrected the wording",
    });

    assert.equal(edited.frontMatter.created, FIXED_TIME.toISOString());
    assert.equal(edited.frontMatter.edited, currentTime.toISOString());
    assert.equal(edited.frontMatter.use_count, created.frontMatter.use_count);
    assert.equal(edited.frontMatter.decay_weight, created.frontMatter.decay_weight);
    assert.equal(edited.frontMatter.title, "Updated Title");
    assert.deepEqual(edited.frontMatter.tags, ["new"]);
    assert.match(edited.body, /Updated body\./);
    assert.match(edited.body, /## audit/);
    assert.match(edited.body, /memory_edit: Corrected the wording/);
    assert.deepEqual(await service.read(created.slug), edited);
  });
});

test("edit requires an existing node and at least one changed field", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () => service.edit("missing", { title: "Nope" }),
      MemoryServiceError,
    );

    const node = await service.add({
      title: "Existing",
      type: "fact",
      body: "Body.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await assert.rejects(
      () => service.edit(node.slug, { reason: "No actual change" }),
      /No memory fields/,
    );
  });
});
