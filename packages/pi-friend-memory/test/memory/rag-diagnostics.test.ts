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
  defaultRagInjectionConfig,
  defaultRecencyInjectionConfig,
} from "../../src/memory/config.ts";
import { buildRagContext, formatRagDiagnostics } from "../../src/memory/rag.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

test("a truncated body and a spent budget are both reported", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    // Two bodies far longer than the fresh tier's allowance, so both are cut.
    const body =
      `The lantern ${"very ".repeat(160)}hangs by the door. ` +
      `The handle ${"quite ".repeat(160)}is chipped.`;
    for (const slug of ["lantern-a", "lantern-b"]) {
      await service.add({
        slug,
        title: slug,
        type: "fact",
        body,
        speaker: [{ name: "Aria", confident: true }],
      });
    }

    // Exactly one 600-character excerpt fits; the second is rendered and then
    // refused, which is the case the diagnostic has to explain.
    const config = {
      ...defaultRagInjectionConfig(),
      mode: "keyword" as const,
      limit: 2,
      maxChars: 650,
    };
    const context = await buildRagContext(service, "lantern", config, {
      ...defaultRecencyInjectionConfig(),
      enabled: false,
    });

    const injected = context.diagnostics.results.find(
      (result) => result.injected,
    );
    assert.ok(injected?.truncation);
    assert.equal(injected.truncation.limit, 600);
    assert.ok(injected.truncation.bodyLength > 600);

    const refused = context.diagnostics.results.find(
      (result) => !result.injected && result.slug !== undefined,
    );
    assert.ok(refused?.budgetExcluded);
    assert.equal(refused.budgetExcluded.limit, 650);
    assert.ok(refused.budgetExcluded.used <= 650);

    const text = formatRagDiagnostics(context.diagnostics);
    assert.match(text, /truncated: \d+\/600 characters \(tier cap\)/u);
    assert.match(
      text,
      /not injected: the section's body budget was spent \(\d+\/650\)/u,
    );
  });
});

test("the diagnostics record the query, the scores and what was injected", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({ agentDir, homeDir: agentDir });
    const service = new MemoryNodeService(repository);
    await service.add({
      slug: "kettle-boils",
      title: "Kettle",
      type: "fact",
      body: "The kettle boils for four minutes.",
      speaker: [{ name: "Aria", confident: true }],
    });
    await service.add({
      slug: "unrelated",
      title: "Unrelated",
      type: "fact",
      body: "Nothing to do with the kettle.",
      speaker: [{ name: "Iri", confident: true }],
    });

    const config = { ...defaultRagInjectionConfig(), mode: "keyword" as const };
    const context = await buildRagContext(service, "\\>>Aria: kettle", config, {
      ...defaultRecencyInjectionConfig(),
      enabled: false,
    });

    assert.equal(context.diagnostics.query, "kettle");
    assert.equal(context.diagnostics.modeUsed, "keyword");
    assert.ok(context.diagnostics.selectedNodeCount >= 1);

    const injected = context.diagnostics.results.find(
      (result) => result.slug === "kettle-boils",
    );
    assert.ok(injected);
    assert.equal(injected.injected, true);
    // The speaker boost from the tag is visible as its own contribution.
    assert.ok(
      injected.keywordContributions?.some(
        (entry) => entry.field === "speaker" && entry.points === 600,
      ),
    );
    assert.equal(
      injected.keywordContributions?.reduce(
        (total, entry) => total + entry.points,
        0,
      ),
      injected.keywordScore,
    );

    // The injected flag agrees with the count the block reported.
    assert.equal(
      context.diagnostics.results.filter((result) => result.injected).length,
      context.diagnostics.selectedNodeCount,
    );

    const text = formatRagDiagnostics(context.diagnostics, "2026-11-08T00:00:00.000Z");
    assert.match(text, /query: "kettle"/u);
    assert.match(text, /INJECTED {2}kettle-boils/u);
    assert.match(text, /points: .*speaker 600/u);
  });
});
