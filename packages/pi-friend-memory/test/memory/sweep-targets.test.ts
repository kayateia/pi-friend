/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/memory/embedding.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import type { MemoryType } from "../../src/memory/schema.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import {
  SWEEP_FALLBACK_WINDOW,
  SWEEP_TARGETS_PER_CANDIDATE,
  runDailySweep,
} from "../../src/memory/sweep.ts";
import {
  buildSweepPrompt,
  type SweepDecision,
} from "../../src/memory/sweep-model.ts";
import { SqliteVectorIndex } from "../../src/memory/vector-index.ts";
import { withTempDir } from "../helpers.ts";

/**
 * Embedding provider that separates kitchen text, garden text and the rest.
 *
 * Three orthogonal directions are enough to make similarity a fact of the test
 * rather than a property of whatever the real provider would have thought.
 */
class TopicProvider implements EmbeddingProvider {
  readonly model = "test/topics";
  readonly dimensions = 3;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("kitchen")) {
        return new Float32Array([1, 0, 0]);
      }
      if (normalized.includes("garden")) {
        return new Float32Array([0, 1, 0]);
      }
      return new Float32Array([0, 0, 1]);
    });
  }
}

/** Opens a service backed by the topic provider. */
async function openSemanticService(agentDir: string) {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  const index = SqliteVectorIndex.open({
    databasePath: ":memory:",
    model: "test/topics",
    dimensions: 3,
  });
  return new MemoryNodeService(
    repository,
    () => new Date("2026-10-20T00:00:00.000Z"),
    { provider: new TopicProvider(), index },
  );
}

/** Adds one canonical node with a title and body the provider can classify. */
async function addNode(
  service: MemoryNodeService,
  title: string,
  body: string,
  type: MemoryType = "fact",
) {
  return service.add({
    title,
    type,
    body,
    speaker: [{ name: "Aisling", confident: true }],
  });
}

test("the shortlist follows relevance and folds repeated proposals together", async () => {
  await withTempDir(async (agentDir) => {
    const service = await openSemanticService(agentDir);
    await addNode(service, "Blue Cup", "The blue cup lives in the kitchen.");
    await addNode(service, "Spoons", "The kitchen drawer holds the spoons.");
    await addNode(service, "Tea Towels", "Kitchen towels dry by the window.");
    await addNode(service, "Tomatoes", "The garden tomatoes ripened early.");
    await addNode(service, "Night Sky", "The stars were unusually bright.");

    // Two candidates on the same topic: without folding, the union would hold
    // the same three kitchen nodes twice over.
    const first = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kitchen kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const second = await service.stageCandidate({
      title: "Teapot",
      type: "fact",
      body: "The kitchen teapot broke.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const targets = await service.selectSweepTargets(
      [first.node, second.node],
      await service.listCanonicalNodes(),
      SWEEP_TARGETS_PER_CANDIDATE,
    );

    assert.deepEqual(
      targets?.map((node) => node.slug).sort(),
      ["blue-cup", "spoons", "tea-towels"],
    );
  });
});

test("relevance reaches a late-alphabet memory that slug order could not", async () => {
  await withTempDir(async (agentDir) => {
    const service = await openSemanticService(agentDir);
    await addNode(service, "Zzz Kitchen Rule", "The kitchen rule is unwritten.");
    await addNode(service, "Aaa Night Sky", "The stars were bright.");

    const candidate = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kitchen kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const targets = await service.selectSweepTargets(
      [candidate.node],
      await service.listCanonicalNodes(),
      1,
    );

    assert.deepEqual(
      targets?.map((node) => node.slug),
      ["zzz-kitchen-rule"],
    );
  });
});

test("a dream is never offered as a merge target", async () => {
  await withTempDir(async (agentDir) => {
    const service = await openSemanticService(agentDir);
    const sourceA = await addNode(service, "First Source", "First source memory.");
    const sourceB = await addNode(service, "Second Source", "Second source memory.");
    const dream = await service.createDream({
      title: "Kitchen Dream",
      narrative: "A kitchen with no walls and a kettle that remembers.",
      nodeSlugs: [sourceA.slug, sourceB.slug],
    });
    await addNode(service, "Blue Cup", "The blue cup lives in the kitchen.");

    const candidate = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kitchen kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const targets = await service.selectSweepTargets(
      [candidate.node],
      // The full list, dreams included: the exclusion has to be the query's,
      // not the caller's, or a future caller could hand a dream back in.
      await service.listCanonicalNodes(),
      10,
    );

    assert.ok(
      !targets?.some((node) => node.slug === dream.slug),
      "a dream must not be a merge target",
    );
    assert.ok(targets?.some((node) => node.slug === "blue-cup"));
  });
});

test("no embedding provider means no selection, not an empty window", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    await addNode(service, "Blue Cup", "The blue cup lives in the kitchen.");
    const candidate = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kitchen kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    assert.equal(
      await service.selectSweepTargets(
        [candidate.node],
        await service.listCanonicalNodes(),
        3,
      ),
      undefined,
    );
  });
});

/**
 * Embedding provider that fails, as a provider outage would.
 *
 * Only selection has to survive one: relevance is an improvement to the window,
 * and losing it should cost the window, not the whole pass. Promotion still
 * embeds for near-duplicate detection, so this test decides to drop — the case
 * that reaches no other embedding call.
 */
class FailingProvider extends TopicProvider {
  override async embed(): Promise<Float32Array[]> {
    throw new Error("embedding provider unavailable");
  }
}

test("a failed selection falls back to the sorted window and warns", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T00:00:00.000Z"),
      {
        provider: new FailingProvider(),
        index: SqliteVectorIndex.open({
          databasePath: ":memory:",
          model: "test/topics",
          dimensions: 3,
        }),
      },
    );
    // The alphabetically first memory is the irrelevant one, so its presence in
    // the window is what distinguishes the fallback from a successful shortlist.
    await addNode(service, "Aaa Night Sky", "The stars were unusually bright.");
    await addNode(service, "Zzz Kitchen Rule", "The kitchen rule is unwritten.");
    const candidate = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kitchen kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const warnings: string[] = [];
    let offered: string[] = [];
    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        background: false,
        minGuardedBatchSize: 10,
        allowDrop: true,
      },
      {
        now: new Date("2026-10-25T05:00:00.000Z"),
        reportWarning: (message) => warnings.push(message),
        decide: async (_candidates, canonical): Promise<SweepDecision[]> => {
          offered = canonical.map((node) => node.slug);
          return [
            {
              slug: candidate.node.slug,
              action: "drop",
              reason: "operational minutiae",
            },
          ];
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.dropped, 1);
    assert.deepEqual(offered, ["aaa-night-sky", "zzz-kitchen-rule"]);
    assert.match(warnings.join("\n"), /could not select merge targets/u);
  });
});

test("a sweep offers the relevance shortlist to the decider", async () => {
  await withTempDir(async (agentDir) => {
    const service = await openSemanticService(agentDir);
    await addNode(service, "Blue Cup", "The blue cup lives in the kitchen.");
    await addNode(service, "Spoons", "The kitchen drawer holds the spoons.");
    await addNode(service, "Tea Towels", "Kitchen towels dry by the window.");
    await addNode(service, "Tomatoes", "The garden tomatoes ripened early.");
    await addNode(service, "Night Sky", "The stars were unusually bright.");

    const candidate = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kitchen kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    let offered: string[] = [];
    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        background: false,
        minGuardedBatchSize: 10,
        allowDrop: false,
      },
      {
        now: new Date("2026-10-25T05:00:00.000Z"),
        decide: async (_candidates, canonical): Promise<SweepDecision[]> => {
          offered = canonical.map((node) => node.slug);
          return [
            {
              slug: candidate.node.slug,
              action: "promote",
              reason: "durable",
            },
          ];
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(offered.sort(), ["blue-cup", "spoons", "tea-towels"]);
  });
});

test("without an embedding provider the window is the old sorted slice", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    // One more than the legacy window, so the cap has to bind.
    for (let index = 0; index < SWEEP_FALLBACK_WINDOW + 2; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await addNode(service, `Note ${suffix}`, `Ordinary memory ${suffix}.`);
    }
    const candidate = await service.stageCandidate({
      title: "Kettle",
      type: "fact",
      body: "A kettle was bought.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    let offered: string[] = [];
    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        background: false,
        minGuardedBatchSize: 10,
        allowDrop: false,
      },
      {
        now: new Date("2026-10-25T05:00:00.000Z"),
        decide: async (_candidates, canonical): Promise<SweepDecision[]> => {
          offered = canonical.map((node) => node.slug);
          return [
            {
              slug: candidate.node.slug,
              action: "promote",
              reason: "durable",
            },
          ];
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(offered.length, SWEEP_FALLBACK_WINDOW);
    assert.equal(offered[0], "note-00");
  });
});

test("the prompt shows every node in the window it is given", () => {
  const canonical = Array.from({ length: SWEEP_FALLBACK_WINDOW + 10 }, (_, index) =>
    makeNode(`memory-${String(index).padStart(2, "0")}`),
  );
  const prompt = buildSweepPrompt([makeNode("candidate")], canonical);
  for (const node of canonical) {
    assert.ok(
      prompt.includes(`"slug": "${node.slug}"`),
      `${node.slug} should be in the prompt`,
    );
  }
});

/** One parsed node shape, as the prompt builder receives it. */
function makeNode(slug: string) {
  return {
    slug,
    body: `\n${slug} body.\n`,
    frontMatter: {
      title: slug,
      type: "fact" as MemoryType,
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created: "2026-10-20T00:00:00Z",
      last_used: "2026-10-20T00:00:00Z",
      use_count: 0,
      decay_weight: 1,
      status: "active" as const,
      emotional_flavour: "neutral",
      tags: [],
      links: [],
      sources: [],
    },
  };
}
