/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  buildSweepPrompt,
  parseSweepResponse,
} from "../../src/memory/sweep-model.ts";
import {
  SWEEP_SYSTEM_PROMPT,
  buildSweepSystemPrompt,
  resolveSweepSystemPrompt,
} from "../../src/memory/prompts.ts";
import { runDailySweep } from "../../src/memory/sweep.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import type { MemoryType } from "../../src/memory/schema.ts";
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
      ],
    }),
    ["promote-me", "merge-me"],
    ["existing"],
  );

  assert.deepEqual(decisions.map((decision) => decision.action), [
    "promote",
    "merge",
  ]);
  const prompt = buildSweepPrompt(
    [makeCandidate("candidate")],
    [makeCandidate("existing")],
  );
  assert.match(prompt, /Candidates:/);
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
        background: false,
        minGuardedBatchSize: 10,
        allowDrop: false,
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
        background: false,
        minGuardedBatchSize: 10,
        allowDrop: false,
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

    const reported: Array<{ label: string; error: unknown }> = [];
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
        now: new Date("2026-10-21T05:00:00.000Z"),
        decide: async () => {
          throw new Error("model unavailable");
        },
        reportError: (label, error) => reported.push({ label, error }),
      },
    );
    assert.equal(result.error, "Error: model unavailable");
    assert.equal(reported[0]?.label, "daily sweep");
    assert.match(String(reported[0]?.error), /model unavailable/u);
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
    assert.equal(state.lastError, "Error: model unavailable");
  });
});

test("an aborted background sweep does not mutate candidates", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const candidate = await service.stageCandidate({
      title: "Abort Candidate",
      type: "fact",
      body: "This candidate must remain staged.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        runDailySweep(
          undefined,
          service,
          {
            enabled: true,
            background: true,
            minGuardedBatchSize: 10,
            allowDrop: false,
          },
          { signal: controller.signal },
        ),
      /aborted/i,
    );
    assert.ok(await service.read(candidate.node.slug, "staging"));
  });
});

test("sweep creates one dream from the canonical nodes", async () => {
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

    assert.ok(result.dreamSlug);
    const dream = await service.read(result.dreamSlug);
    assert.equal(dream?.frontMatter.type, "dream");
    assert.deepEqual(dream?.frontMatter.links, [
      first.slug,
      second.slug,
    ]);
  });
});

test("small batches may expire more than 25% below the guard threshold", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const candidate = await service.stageCandidate({
      title: "Small Batch Expiry",
      type: "fact",
      body: "This small batch may expire.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    candidate.node.frontMatter.decay_weight = 0.05;
    await repository.write(candidate.node, "staging");

    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        background: false,
        minGuardedBatchSize: 5,
        allowDrop: false,
      },
      {
        now: new Date("2026-10-22T05:00:00.000Z"),
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

test("a removal over a quarter is reported, and still applied", async () => {
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
    first.node.frontMatter.decay_weight = 0.05;
    second.node.frontMatter.decay_weight = 0.05;
    await repository.write(first.node, "staging");
    await repository.write(second.node, "staging");

    const warnings: string[] = [];
    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        background: false,
        minGuardedBatchSize: 2,
        allowDrop: false,
      },
      {
        now: new Date("2026-10-23T05:00:00.000Z"),
        reportWarning: (message) => warnings.push(message),
      },
    );

    // Reported, not refused: the expiry is the correct outcome, and a refusal
    // would leave the queue larger than it found it.
    assert.equal(result.error, undefined);
    assert.equal(result.dropped, 2);
    assert.match(warnings.join("\n"), /removed 2 of 2 staged candidates \(100%\)/u);
    assert.equal(await service.read(first.node.slug, "staging"), null);
    assert.equal(await service.read(second.node.slug, "staging"), null);
  });
});


test("drop is offered only when allow_drop is enabled", () => {
  const response = JSON.stringify({
    decisions: [
      { slug: "candidate", action: "drop", reason: "a misunderstanding" },
    ],
  });

  assert.deepEqual(
    parseSweepResponse(response, ["candidate"], [], false),
    [],
  );
  assert.deepEqual(
    parseSweepResponse(response, ["candidate"], [], true).map(
      (decision) => decision.action,
    ),
    ["drop"],
  );

  const withoutDrop = buildSweepPrompt([makeCandidate("c")], []);
  const withDrop = buildSweepPrompt([makeCandidate("c")], [], true);
  assert.match(withoutDrop, /"action":"promote\|merge"/);
  assert.match(withDrop, /"action":"promote\|merge\|drop"/);

  assert.doesNotMatch(SWEEP_SYSTEM_PROMPT, /`drop`/);
  assert.match(buildSweepSystemPrompt(true), /`promote`, `merge`, or `drop`/);
  assert.match(
    buildSweepSystemPrompt(true),
    /dropped candidates are archived, not deleted/,
  );
  assert.doesNotMatch(buildSweepSystemPrompt(false), /`drop`/);
});

test("prompt_append extends the drop-enabled sweep prompt", () => {
  const prompt = resolveSweepSystemPrompt(
    { promptAppend: "Prefer promoting distinct facts." },
    true,
  );
  assert.match(prompt, /`promote`, `merge`, or `drop`/);
  assert.ok(prompt.endsWith("Prefer promoting distinct facts."));
});

test("an allowed drop archives the candidate instead of promoting it", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-24T05:00:00.000Z"),
    );
    const candidate = await service.stageCandidate({
      title: "Droppable Candidate",
      type: "fact",
      body: "An incorrect capture worth discarding.",
      speaker: [{ name: "Aisling", confident: true }],
    });

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
        now: new Date("2026-10-24T05:00:00.000Z"),
        decide: async () => [
          {
            slug: candidate.node.slug,
            action: "drop",
            reason: "misunderstood the speaker",
          },
        ],
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.dropped, 1);
    assert.equal(result.promoted, 0);
    assert.equal(result.merged, 0);
    assert.equal(await service.read(candidate.node.slug, "staging"), null);
    assert.equal(await service.read(candidate.node.slug), null);

    const archived = await readFile(
      path.join(
        repository.store.paths.root,
        "history",
        "dropped",
        `${candidate.node.slug}.md`,
      ),
      "utf8",
    );
    assert.match(archived, /incorrect capture worth discarding/);
  });
});

test("model drops count toward the reported removal ratio", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const candidates: string[] = [];
    for (const title of ["Guard One", "Guard Two", "Guard Three", "Guard Four"]) {
      const staged = await service.stageCandidate({
        title,
        type: "fact",
        body: `${title} body.`,
        speaker: [{ name: "Aisling", confident: true }],
      });
      candidates.push(staged.node.slug);
    }

    const warnings: string[] = [];
    const result = await runDailySweep(
      undefined,
      service,
      {
        enabled: true,
        background: false,
        minGuardedBatchSize: 2,
        allowDrop: true,
      },
      {
        now: new Date("2026-10-24T05:00:00.000Z"),
        reportWarning: (message) => warnings.push(message),
        decide: async () =>
          candidates.slice(0, 2).map((slug) => ({
            slug,
            action: "drop" as const,
            reason: "not worth keeping",
          })),
      },
    );

    // Half the queue dropped is worth saying out loud, and is still the model's
    // call: the drops applied, and the archive can give them back.
    assert.equal(result.error, undefined);
    assert.match(warnings.join("\n"), /removed 2 of 4 staged candidates \(50%\)/u);
    for (const slug of candidates.slice(0, 2)) {
      assert.equal(await service.read(slug, "staging"), null);
    }
    for (const slug of candidates.slice(2)) {
      assert.ok(await service.read(slug, "staging"));
    }
  });
});


test("dreams are withheld from the sweep's merge targets", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-25T05:00:00.000Z"),
    );
    const ordinary = await service.add({
      title: "Ordinary Memory",
      type: "fact",
      body: "An ordinary canonical memory.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const dream = await service.createDream({
      title: "Dream Of Two",
      narrative: "A dream woven from two memories.",
      nodeSlugs: [ordinary.slug, (await service.add({
        title: "Second Ordinary",
        type: "fact",
        body: "Another ordinary canonical memory.",
        speaker: [{ name: "Aisling", confident: true }],
      })).slug],
    });
    const candidate = await service.stageCandidate({
      title: "Mergeable Candidate",
      type: "fact",
      body: "A candidate that wants merging into something real.",
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
        decide: async (candidates, canonical) => {
          offered = canonical.map((node) => node.slug);
          return [
            {
              slug: candidates[0]?.slug ?? candidate.node.slug,
              action: "promote",
              reason: "durable",
            },
          ];
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.ok(offered.length >= 2);
    assert.ok(!offered.includes(dream.slug));
    // The dream still exists; it simply is not filterable as a merge target.
    assert.ok(await service.read(dream.slug));
  });
});


test("the service refuses a merge into a dream even when asked directly", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    const first = await service.add({
      title: "First Source",
      type: "fact",
      body: "First dream source.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const second = await service.add({
      title: "Second Source",
      type: "fact",
      body: "Second dream source.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const dream = await service.createDream({
      title: "Refused Dream",
      narrative: "A dream that must stay fiction.",
      nodeSlugs: [first.slug, second.slug],
    });
    const candidate = await service.stageCandidate({
      title: "Would Be Contaminated",
      type: "fact",
      body: "Ordinary content that must not enter a dream.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    // The decider is filtered, but the write path is guarded too — so a caller
    // that names a dream anyway gets an error rather than a fabricated memory.
    await assert.rejects(
      service.promoteCandidate(candidate.node.slug, dream.slug),
      /Cannot merge a staging candidate into dream memory/,
    );
    assert.ok(await service.read(candidate.node.slug, "staging"));
  });
});


test("two candidates merging into one target make one writer call", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const calls: string[][] = [];
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-24T05:00:00.000Z"),
      undefined,
      undefined,
      async (sources) => {
        calls.push(sources.map((source) => source.slug));
        return { body: "Consolidated by the writer." };
      },
    );
    const target = await service.add({
      title: "Merge Target",
      type: "fact",
      body: "Target body.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const first = await service.stageCandidate({
      title: "First To Merge",
      type: "fact",
      body: "First body.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const second = await service.stageCandidate({
      title: "Second To Merge",
      type: "fact",
      body: "Second body.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const result = await runDailySweep(
      undefined,
      service,
      { enabled: true, background: false, minGuardedBatchSize: 10, allowDrop: false },
      {
        force: true,
        now: new Date("2026-10-24T05:00:00.000Z"),
        decide: async () => [
          { slug: first.node.slug, action: "merge", target: target.slug, reason: "same fact" },
          { slug: second.node.slug, action: "merge", target: target.slug, reason: "same fact" },
        ],
      },
    );

    assert.deepEqual(calls, [
      [target.slug, first.node.slug, second.node.slug],
    ]);
    assert.equal(result.merged, 2);
    assert.equal(result.promoted, 0);
    assert.equal(
      (await service.read(target.slug))?.body.trim(),
      "Consolidated by the writer.",
    );
  });
});

/** Builds a minimal sweep prompt node fixture. */
function makeCandidate(slug: string, type: MemoryType = "fact") {
  return {
    slug,
    body: `\n${slug} body.\n`,
    frontMatter: {
      title: slug,
      type,
      speaker: [{ name: "Aisling", confident: true }],
      agents: [],
      created: "2026-10-20T00:00:00Z",
      last_used: "2026-10-20T00:00:00Z",
      use_count: 0,
      decay_weight: 1,
      status: "active" as const,
      emotional_flavour: "neutral",
      tags: [],
      supersedes: [],
      superseded_by: "",
      links: [],
      source: "",
    },
  };
}
