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
  buildDreamPrompt,
  parseDreamResponse,
  selectDreamShortlist,
} from "../../src/memory/dream.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

test("dream shortlist prefers linked nodes and parses model output", () => {
  const a = makeNode("a", ["b"]);
  const b = makeNode("b", ["a"]);
  const c = makeNode("c", []);
  const shortlist = selectDreamShortlist([c, a, b], 2, () => 0.5);

  assert.deepEqual(shortlist.map((node) => node.slug), ["a", "b", "c"]);
  assert.match(buildDreamPrompt(shortlist, 2), /genuinely want to sit with/);
  assert.deepEqual(
    parseDreamResponse(
      '{"title":"A Dream","nodeSlugs":["a","b"],"narrative":"I sat with them."}',
      ["a", "b", "c"],
      2,
    ),
    {
      title: "A Dream",
      nodeSlugs: ["a", "b"],
      narrative: "I sat with them.",
    },
  );
});

test("dream creation stores quarantined provenance and links", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T05:00:00.000Z"),
    );
    const first = await service.add({
      title: "First Source",
      type: "fact",
      body: "First source body.",
      speaker: [{ name: "Aisling", confident: true }],
      tags: ["first"],
    });
    const second = await service.add({
      title: "Second Source",
      type: "event",
      body: "Second source body.",
      speaker: [{ name: "Aisling", confident: true }],
      tags: ["second"],
    });

    const dream = await service.createDream({
      title: "Kitchen Dream",
      narrative: "I sat between two memories and let them speak.",
      nodeSlugs: [first.slug, second.slug],
      agents: ["test-model"],
      source: "sweep:test",
    });

    assert.equal(dream.frontMatter.type, "dream");
    assert.deepEqual(dream.frontMatter.links, [
      first.slug,
      second.slug,
    ]);
    assert.equal(dream.frontMatter.status, "active");
    assert.match(dream.frontMatter.source, /sweep:test/);
    assert.match(dream.body, /Dream synthesized from:/);
    assert.match(dream.body, /see also:/);
  });
});

/** Builds a minimal dream input node fixture. */
function makeNode(slug: string, links: string[]) {
  return {
    slug,
    body: `\n${slug}.\n`,
    frontMatter: {
      title: slug,
      type: "fact" as const,
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created: "2026-10-20T00:00:00Z",
      last_used: "2026-10-20T00:00:00Z",
      use_count: 0,
      decay_weight: 1,
      status: "active" as const,
      emotional_flavor: "neutral",
      tags: [],
      supersedes: [],
      superseded_by: "",
      links,
      source: "",
    },
  };
}
