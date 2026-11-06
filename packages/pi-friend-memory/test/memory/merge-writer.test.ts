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
import {
  buildMergePrompt,
  parseMergeResponse,
  toMergeSource,
  type MergeRewrite,
  type MergeSource,
} from "../../src/memory/merge-writer.ts";
import { MERGE_SYSTEM_PROMPT } from "../../src/memory/prompts.ts";
import { withTempDir } from "../helpers.ts";

const FIXED_TIME = new Date("2026-10-19T20:00:00.000Z");

/** Creates a service whose writer is a stub, so no model is involved. */
async function makeService(
  agentDir: string,
  writer?: (sources: MergeSource[]) => Promise<MergeRewrite>,
): Promise<{ service: MemoryNodeService; repository: MemoryNodeRepository }> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  const service = new MemoryNodeService(
    repository,
    () => FIXED_TIME,
    undefined,
    undefined,
    writer,
  );
  return { service, repository };
}

test("the merge prompt carries sources with speakers and dates", () => {
  const prompt = buildMergePrompt([
    {
      slug: "blue-cup",
      title: "Blue Cup",
      type: "fact",
      speaker: [{ name: "Aisling", confident: true }],
      date: "2026-10-19T20:00:00.000Z",
      body: "The blue cup belongs on the second shelf.",
    },
  ]);
  assert.match(prompt, /"body":"consolidated memory body"/);
  assert.match(prompt, /"slug": "blue-cup"/);
  assert.match(prompt, /"name": "Aisling"/);
  assert.match(prompt, /"date": "2026-10-19T20:00:00.000Z"/);
});

test("the merge prompt says corrections are not conflicts", () => {
  assert.match(
    MERGE_SYSTEM_PROMPT,
    /A correction, a changed preference, or a superseded fact is not a conflict/u,
  );
  // The field is for claims nothing can order, not for disagreements a date settles.
  assert.match(MERGE_SYSTEM_PROMPT, /nothing in them says which is newer/u);
  assert.match(MERGE_SYSTEM_PROMPT, /Leave `conflict` empty in every other case/u);
});

test("the merge prompt says archaeology and gloss are discouraged", () => {
  assert.match(MERGE_SYSTEM_PROMPT, /Archaeology/);
  assert.match(MERGE_SYSTEM_PROMPT, /Editorialising/);
  assert.match(MERGE_SYSTEM_PROMPT, /Never cut durable content/);
  // The "one key fact" rule belongs to the deciding model, not this one.
  assert.doesNotMatch(MERGE_SYSTEM_PROMPT, /one key fact/);
});

test("a merge response keeps its conflict note when there is one", () => {
  assert.deepEqual(
    parseMergeResponse(
      '```json\n{"body":"  Consolidated body.  ","conflict":"The dates disagree."}\n```',
    ),
    { body: "Consolidated body.", conflict: "The dates disagree." },
  );
  assert.deepEqual(parseMergeResponse('{"body":"Body.","conflict":" "}'), {
    body: "Body.",
  });
});

test("a merge response without a usable body is rejected", () => {
  for (const response of ['{"body":""}', '{"body":"   "}', "no json here", "[]"]) {
    assert.throws(() => parseMergeResponse(response), /Merge response/);
  }
});

test("one writer call consolidates every candidate for a target", async () => {
  await withTempDir(async (agentDir) => {
    const calls: MergeSource[][] = [];
    const { service, repository } = await makeService(agentDir, async (sources) => {
      calls.push(sources);
      return {
        body: "One consolidated body from three accounts.",
        conflict: "Two dates disagree.",
      };
    });

    const target = await service.add({
      title: "Target",
      type: "fact",
      body: "Target body.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const first = await service.stageCandidate({
      title: "First",
      type: "fact",
      body: "First candidate body.",
      speaker: [{ name: "Aria", confident: true }],
    });
    const second = await service.stageCandidate({
      title: "Second",
      type: "fact",
      body: "Second candidate body.",
      speaker: [{ name: "Destiny", confident: true }],
    });

    const result = await service.mergeCandidates(target.slug, [
      first.node.slug,
      second.node.slug,
    ]);

    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]?.map((source) => source.slug),
      [target.slug, first.node.slug, second.node.slug],
    );
    assert.equal(result.rewritten, true);
    assert.equal(result.node.body.trim(), "One consolidated body from three accounts.");
    assert.equal(await service.read(first.node.slug, "staging"), null);
    assert.equal(await service.read(second.node.slug, "staging"), null);

    // Every input is archived, and the conflict lands on the target's entry.
    for (const slug of [target.slug, first.node.slug, second.node.slug]) {
      const entries = await repository.store.listDirectoryMarkdown(
        `history/merged/${slug}`,
      );
      assert.equal(entries.length, 1, slug);
    }
    const targetEntry = await repository.store.listDirectoryMarkdown(
      `history/merged/${target.slug}`,
    );
    const archived = await repository.store.readTextFileIfExists(
      targetEntry[0] ?? "",
    );
    assert.match(archived ?? "", /history_conflict: Two dates disagree\./);
  });
});

test("a failing writer falls back to appending and reports it", async () => {
  await withTempDir(async (agentDir) => {
    const warnings: string[] = [];
    const { service } = await makeService(agentDir, async () => {
      throw new Error("model exploded");
    });

    const target = await service.add({
      title: "Target",
      type: "fact",
      body: "Target body.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const staged = await service.stageCandidate({
      title: "Candidate",
      type: "fact",
      body: "Candidate body.",
      speaker: [{ name: "Aria", confident: true }],
    });

    const result = await service.mergeCandidates(target.slug, [staged.node.slug], {
      reportWarning: (message) => warnings.push(message),
    });

    assert.equal(result.rewritten, false);
    assert.match(result.rewriteError ?? "", /model exploded/);
    assert.match(result.node.body, /Target body\./);
    assert.match(result.node.body, /Candidate body\./);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /mechanical append/);
  });
});

test("a source's date is edited when present, created otherwise", () => {
  const base = {
    slug: "blue-cup",
    body: "\nBody.\n",
    frontMatter: {
      title: "Blue Cup",
      type: "fact" as const,
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created: "2026-10-19T20:00:00.000Z",
      last_used: "2026-10-19T20:00:00.000Z",
      use_count: 0,
      decay_weight: 1,
      status: "active" as const,
      emotional_flavor: "neutral",
      tags: [],
      supersedes: [],
      superseded_by: "",
      links: [],
      source: "",
    },
  };
  assert.equal(toMergeSource(base).date, "2026-10-19T20:00:00.000Z");
  assert.equal(
    toMergeSource({
      ...base,
      frontMatter: { ...base.frontMatter, edited: "2026-11-02T00:00:00.000Z" },
    }).date,
    "2026-11-02T00:00:00.000Z",
  );
});

test("a manual merge can combine two canonical memories", async () => {
  await withTempDir(async (agentDir) => {
    let writerCalls = 0;
    const { service, repository } = await makeService(agentDir, async () => {
      writerCalls += 1;
      return { body: "Written by the merge model." };
    });

    const target = await service.add({
      title: "House Rules",
      type: "fact",
      body: "Rules live here.",
      speaker: [{ name: "Aria", confident: true }],
    });
    const source = await service.add({
      title: "Old Rules",
      type: "fact",
      body: "An older statement of the same rules.",
      speaker: [{ name: "Aria", confident: true }],
    });

    const result = await service.mergeCandidates(target.slug, [source.slug]);

    assert.equal(writerCalls, 1);
    assert.equal(result.node.body.trim(), "Written by the merge model.");
    assert.deepEqual(result.removedMemories, [source.slug]);
    assert.deepEqual(result.removedCandidates, []);
    // The source is gone from canonical memory and archived as a version.
    assert.equal(await service.read(source.slug), null);
    assert.equal(
      (await repository.store.listDirectoryMarkdown(
        `history/merged/${source.slug}`,
      )).length,
      1,
    );
  });
});

test("a supplied body replaces the writer entirely", async () => {
  await withTempDir(async (agentDir) => {
    let writerCalls = 0;
    const { service } = await makeService(agentDir, async () => {
      writerCalls += 1;
      return { body: "Written by the merge model." };
    });
    const target = await service.add({
      title: "Written By Hand",
      type: "fact",
      body: "Target body.",
      speaker: [{ name: "Aria", confident: true }],
    });
    const source = await service.add({
      title: "Absorbed",
      type: "fact",
      body: "Source body.",
      speaker: [{ name: "Aria", confident: true }],
    });

    const result = await service.mergeCandidates(target.slug, [source.slug], {
      body: "Exactly this text, no rewrite.",
    });

    assert.equal(writerCalls, 0);
    assert.equal(result.bodySupplied, true);
    assert.equal(result.rewritten, true);
    assert.equal(result.node.body.trim(), "Exactly this text, no rewrite.");
  });
});

test("a merge refuses a target merged into itself and unknown sources", async () => {
  await withTempDir(async (agentDir) => {
    const { service } = await makeService(agentDir);
    const target = await service.add({
      title: "Target",
      type: "fact",
      body: "Target body.",
      speaker: [{ name: "Aria", confident: true }],
    });

    await assert.rejects(
      () => service.mergeCandidates(target.slug, [target.slug]),
      /into itself/,
    );
    await assert.rejects(
      () => service.mergeCandidates(target.slug, ["never-existed"]),
      /No memory or staging candidate found/,
    );
    // Nothing was changed by either refusal.
    assert.ok(await service.read(target.slug));
  });
});

test("repeated source slugs merge once", async () => {
  await withTempDir(async (agentDir) => {
    const { service } = await makeService(agentDir, async () => ({
      body: "Merged.",
    }));
    const target = await service.add({
      title: "Target",
      type: "fact",
      body: "Target body.",
      speaker: [{ name: "Aria", confident: true }],
    });
    const source = await service.add({
      title: "Source",
      type: "fact",
      body: "Source body.",
      speaker: [{ name: "Aria", confident: true }],
    });

    const result = await service.mergeCandidates(target.slug, [
      source.slug,
      source.slug,
    ]);
    assert.deepEqual(result.removedMemories, [source.slug]);
  });
});
