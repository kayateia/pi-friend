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
): Promise<MemoryNodeService> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return new MemoryNodeService(repository, () => FIXED_TIME);
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
