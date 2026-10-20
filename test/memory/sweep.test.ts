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
      { enabled: true, tombstoneGraceDays: 30 },
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
      { enabled: true, tombstoneGraceDays: 30 },
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
      { enabled: true, tombstoneGraceDays: 30 },
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
