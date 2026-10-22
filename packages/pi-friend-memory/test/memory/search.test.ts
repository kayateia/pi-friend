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
import { withTempDir } from "../helpers.ts";

/** Creates a service backed by an isolated memory tree. */
async function makeService(
  agentDir: string,
): Promise<{
  repository: MemoryNodeRepository;
  service: MemoryNodeService;
}> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return {
    repository,
    service: new MemoryNodeService(repository),
  };
}

test("keyword search ranks exact slug, title, tag, and body matches", async () => {
  await withTempDir(async (agentDir) => {
    const { service } = await makeService(agentDir);
    const common = {
      type: "fact" as const,
      speaker: [{ name: "Aisling", confident: true }],
    };
    await service.add({
      ...common,
      slug: "lantern",
      title: "Slug Match",
      body: "No keyword here.",
    });
    await service.add({
      ...common,
      slug: "title-match",
      title: "Lantern",
      body: "No keyword here.",
    });
    await service.add({
      ...common,
      slug: "tag-match",
      title: "Tag Match",
      body: "No keyword here.",
      tags: ["lantern"],
    });
    await service.add({
      ...common,
      slug: "body-match",
      title: "Body Match",
      body: "The lantern appears in this body.",
    });

    const results = await service.search({ query: "lantern" });
    assert.deepEqual(
      results.map((result) => result.slug),
      ["lantern", "title-match", "tag-match", "body-match"],
    );
    assert.deepEqual(results[0]?.matchedFields, ["slug", "path"]);
    assert.deepEqual(results[1]?.matchedFields, ["title"]);
    assert.deepEqual(results[2]?.matchedFields, ["tags"]);
    assert.deepEqual(results[3]?.matchedFields, ["body"]);
  });
});

test("search finds ordinary documents and returns typed results", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeService(agentDir);
    await service.add({
      title: "Memory Result",
      type: "fact",
      body: "Shared lighthouse topic.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await repository.store.writeTextFile(
      "docs/lighthouse.md",
      "# Lighthouse Reference\n\nA plain document about a lighthouse.\n",
    );

    const results = await service.search({ query: "lighthouse" });
    assert.equal(results.length, 2);
    assert.deepEqual(
      new Set(results.map((result) => result.kind)),
      new Set(["node", "document"]),
    );
    const document = results.find((result) => result.kind === "document");
    assert.ok(document);
    assert.equal(document.relativePath, "docs/lighthouse.md");
    assert.equal(document.title, "Lighthouse Reference");
    assert.match(document.snippet, /lighthouse/);
  });
});

test("type filters exclude documents and other memory types", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeService(agentDir);
    const speaker = [{ name: "Aisling", confident: true }];
    await service.add({
      title: "Violet Fact",
      type: "fact",
      body: "Violet fact body.",
      speaker,
    });
    await service.add({
      title: "Violet Preference",
      type: "preference",
      body: "Violet preference body.",
      speaker,
    });
    await repository.store.writeTextFile(
      "docs/violet.md",
      "# Violet Document\n\nViolet document body.\n",
    );

    const results = await service.search({
      query: "violet",
      type: "preference",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.type, "preference");
    assert.equal(results[0]?.kind, "node");
  });
});

test("search applies limits and records one access-log entry per result", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeService(agentDir);
    for (const suffix of ["one", "two", "three"]) {
      await service.add({
        title: `Comet ${suffix}`,
        type: "event",
        body: `Comet ${suffix} body.`,
        speaker: [{ name: "Aisling", confident: true }],
      });
    }

    const results = await service.search({ query: "comet", limit: 2 });
    assert.equal(results.length, 2);

    const accessLog = await repository.store.readTextFile("access-log");
    const lines = accessLog.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        source: string;
        tier: string;
        query: string;
      };
      assert.equal(entry.source, "tool");
      assert.equal(entry.tier, "keyword");
      assert.equal(entry.query, "comet");
    }
  });
});

test("malformed nodes remain discoverable as documents", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeService(agentDir);
    await repository.store.writeTextFile(
      "nodes/damaged.md",
      "# Damaged Node\n\nA recoverable damaged-node phrase.\n",
    );

    const results = await service.search({ query: "damaged-node phrase" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "document");
    assert.match(results[0]?.schemaError ?? "", /strict YAML front matter/);
    assert.match(results[0]?.snippet ?? "", /damaged-node phrase/);
  });
});
