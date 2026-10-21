/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  buildSweepPrompt,
  parseSweepResponse,
} from "../../src/memory/sweep-model.ts";
import { runDailySweep } from "../../src/memory/sweep.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

test("sweep response parsing validates candidate actions and targets", () => {
  const decisions = parseSweepResponse(
    JSON.stringify({
      decisions: [
        {
          slug: "promote-me",
          action: "promote",
          reason: "durable preference",
        },
        {
          slug: "merge-me",
          action: "merge",
          target: "existing",
          reason: "same topic",
        },
        {
          slug: "drop-me",
          action: "drop",
          reason: "transient",
        },
      ],
    }),
    ["promote-me", "merge-me", "drop-me"],
    ["existing"],
  );

  assert.deepEqual(decisions.map((decision) => decision.action), [
    "promote",
    "merge",
    "drop",
  ]);
  assert.match(
    buildSweepPrompt(
      [
        {
          ...makeCandidate("candidate"),
        },
      ],
      [makeCandidate("existing")],
    ),
    /Candidates:/,
  );
});

test("daily sweep writes preimage, state, log, and promotes candidates", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T05:00:00.000Z"),
    );
    const candidate = await service.stageCandidate({
      title: "Sweep Candidate",
      type: "fact",
      body: "A durable sweep candidate.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        tombstoneGraceDays: 30,
        minGuardedBatchSize: 10,
      },
      {
        now: new Date("2026-10-20T05:00:00.000Z"),
        decide: async () => [
          {
            slug: candidate.node.slug,
            action: "promote",
            reason: "durable",
          },
        ],
      },
    );

    assert.equal(result.ran, true);
    assert.equal(result.promoted, 1);
    assert.equal(result.error, undefined);
    assert.ok(result.preimage);
    await access(path.join(repository.store.paths.root, result.preimage));
    assert.equal(await service.read(candidate.node.slug, "staging"), null);
    assert.equal(
      (await service.read(candidate.node.slug))?.frontMatter.status,
      "active",
    );

    const state = JSON.parse(
      await readFile(
        path.join(repository.store.paths.sweeps, "state.json"),
        "utf8",
      ),
    ) as {
      lastSuccessfulAt: string;
    };
    assert.equal(state.lastSuccessfulAt, "2026-10-20T05:00:00.000Z");
    const log = await readFile(
      path.join(repository.store.paths.sweeps, "2026-10-20.md"),
      "utf8",
    );
    assert.match(log, /promote — durable/);

    const second = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        tombstoneGraceDays: 30,
        minGuardedBatchSize: 10,
      },
      { now: new Date("2026-10-20T06:00:00.000Z") },
    );
    assert.equal(second.ran, false);
  });
});

test("sweep failure still advances state and writes a failure log", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const candidate = await service.stageCandidate({
      title: "Unswept",
      type: "fact",
      body: "Candidate stays staged.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        tombstoneGraceDays: 30,
        minGuardedBatchSize: 10,
      },
      {
        now: new Date("2026-10-21T05:00:00.000Z"),
        decide: async () => {
          throw new Error("model unavailable");
        },
      },
    );
    assert.equal(result.error, "model unavailable");
    assert.ok(await service.read(candidate.node.slug, "staging"));
    const state = JSON.parse(
      await readFile(
        path.join(repository.store.paths.sweeps, "state.json"),
        "utf8",
      ),
    ) as {
      lastAttemptAt: string;
      lastError: string;
    };
    assert.equal(state.lastAttemptAt, "2026-10-21T05:00:00.000Z");
    assert.equal(state.lastError, "model unavailable");
  });
});

test("sweep archives expired tombstones and creates one dream", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-01-01T05:00:00.000Z"),
    );
    const first = await service.add({
      title: "First Dream Source",
      type: "fact",
      body: "First source for dreaming.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const second = await service.add({
      title: "Second Dream Source",
      type: "event",
      body: "Second source for dreaming.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const deleted = await service.add({
      title: "Expired Tombstone",
      type: "fact",
      body: "This tombstone is old.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.delete(deleted.slug);

    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        tombstoneGraceDays: 30,
        minGuardedBatchSize: 10,
      },
      {
        now: new Date("2026-02-15T05:00:00.000Z"),
        dreaming: { enabled: true, maxNodes: 3 },
        dream: async () => ({
          title: "Sweep Dream",
          narrative: "I held the two sources together.",
          nodeSlugs: [first.slug, second.slug],
          agents: ["test-model"],
        }),
      },
    );

    assert.equal(result.archivedTombstones, 1);
    assert.equal(
      await service.read(deleted.slug, "superseded"),
      null,
    );
    assert.ok(
      await readFile(
        path.join(
          repository.store.paths.sweeps,
          "archived",
          result.runId ?? "",
          `${deleted.slug}.md`,
        ),
        "utf8",
      ),
    );
    assert.ok(result.dreamSlug);
    const dream = await service.read(result.dreamSlug);
    assert.equal(dream?.frontMatter.type, "dream");
    assert.deepEqual(dream?.frontMatter.links, [
      first.slug,
      second.slug,
    ]);
  });
});

test("small batches may remove more than 25% below the guard threshold", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const candidate = await service.stageCandidate({
      title: "Small Batch Drop",
      type: "fact",
      body: "This small batch may be dropped.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        tombstoneGraceDays: 30,
        minGuardedBatchSize: 5,
      },
      {
        now: new Date("2026-10-22T05:00:00.000Z"),
        decide: async () => [
          {
            slug: candidate.node.slug,
            action: "drop",
            reason: "small batch cleanup",
          },
        ],
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.dropped, 1);
    assert.equal(
      await service.read(candidate.node.slug, "staging"),
      null,
    );
  });
});

test("the 25% guard still applies at the configured batch threshold", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const first = await service.stageCandidate({
      title: "Guarded One",
      type: "fact",
      body: "First guarded candidate.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const second = await service.stageCandidate({
      title: "Guarded Two",
      type: "fact",
      body: "Second guarded candidate.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        tombstoneGraceDays: 30,
        minGuardedBatchSize: 2,
      },
      {
        now: new Date("2026-10-23T05:00:00.000Z"),
        decide: async () => [
          {
            slug: first.node.slug,
            action: "drop",
            reason: "guarded removal",
          },
          {
            slug: second.node.slug,
            action: "promote",
            reason: "durable",
          },
        ],
      },
    );

    assert.match(result.error ?? "", /guard applies at 2 or more/);
    assert.ok(await service.read(first.node.slug, "staging"));
    assert.ok(await service.read(second.node.slug, "staging"));
  });
});

/** Builds a minimal sweep prompt node fixture. */
function makeCandidate(slug: string) {
  return {
    slug,
    body: `\n${slug} body.\n`,
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
      links: [],
      source: "",
    },
  };
}
