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

    const results = await service.search({ query: "lantern", mode: "keyword" });
    assert.deepEqual(
      results.map((result) => result.slug),
      ["lantern", "title-match", "tag-match", "body-match"],
    );
    assert.deepEqual(results[0]?.matchedFields, ["slug", "path"]);
    assert.deepEqual(results[1]?.matchedFields, ["title"]);
    assert.deepEqual(results[2]?.matchedFields, ["tags"]);
    assert.deepEqual(results[3]?.matchedFields, ["body"]);
    assert.deepEqual(
      results.map((result) => result.keywordRank),
      [1, 2, 3, 4],
    );
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

    const results = await service.search({ query: "lighthouse", mode: "keyword" });
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
      mode: "keyword",
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

    const results = await service.search({ query: "comet", mode: "keyword", limit: 2 });
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

    const results = await service.search({ query: "damaged-node phrase", mode: "keyword" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "document");
    assert.match(results[0]?.schemaError ?? "", /strict YAML front matter/);
    assert.match(results[0]?.snippet ?? "", /damaged-node phrase/);
  });
});

test("corpus narrows a search to memory or documents", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeService(agentDir);
    const common = {
      type: "fact" as const,
      speaker: [{ name: "Aisling", confident: true }],
    };
    const node = await service.add({
      ...common,
      title: "Harbour Note",
      body: "The harbour bell rings once at dusk.",
    });
    const candidate = await service.stageCandidate({
      ...common,
      title: "Harbour Candidate",
      body: "A staged note about the harbour bell.",
    });
    await repository.store.writeTextFile(
      "docs/harbour.md",
      "# Harbour Document\nThe harbour bell appears in an imported file.\n",
    );

    const memory = await service.search({ query: "harbour bell", mode: "keyword", corpus: "memory" });
    assert.deepEqual(
      memory.map((result) => result.kind).sort(),
      ["node", "staging-candidate"],
    );
    assert.ok(memory.some((result) => result.slug === node.slug));
    assert.ok(memory.some((result) => result.slug === candidate.node.slug));

    const documents = await service.search({
      query: "harbour bell",
      mode: "keyword",
      corpus: "documents",
    });
    assert.deepEqual(
      documents.map((result) => result.relativePath),
      ["docs/harbour.md"],
    );

    const all = await service.search({ query: "harbour bell", mode: "keyword", corpus: "all" });
    assert.equal(all.length, 3);

    await assert.rejects(
      () =>
        service.search({
          query: "harbour bell",
          corpus: "memory",
          kinds: ["document"],
        }),
      /cannot set both corpus and kinds/,
    );
  });
});

test("search results carry speaker attribution", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeService(agentDir);
    await service.add({
      title: "Attributed Memory",
      type: "preference",
      body: "Prefers being asked before being advised.",
      speaker: [
        { name: "Aria", confident: true, note: "stated it directly" },
        { name: "Iri", confident: false, note: "relayed Aria's observation" },
      ],
    });
    await repository.store.writeTextFile(
      "docs/plain.md",
      "# Plain Document\nA document with no attribution.\n",
    );

    const node = await service.search({
      query: "Attributed Memory",
      mode: "keyword",
      corpus: "memory",
    });
    assert.deepEqual(
      node[0]?.speaker?.map((speaker) => speaker.name),
      ["Aria", "Iri"],
    );
    assert.equal(node[0]?.speaker?.[1]?.confident, false);

    const document = await service.search({
      query: "Plain Document",
      mode: "keyword",
      corpus: "documents",
    });
    assert.equal(document[0]?.speaker, undefined);
  });
});

/** Three memories that separate "said by Aria" from "mentions Aria" from neither. */
async function speakerFixture(agentDir: string): Promise<MemoryNodeService> {
  const { service } = await makeService(agentDir);
  await service.add({
    slug: "by-aria-about-tea",
    title: "Tea",
    type: "fact",
    body: "The kettle boils for four minutes.",
    speaker: [{ name: "Aria", confident: true }],
  });
  await service.add({
    slug: "mentions-aria",
    title: "Aroha",
    type: "fact",
    body: "Aria prefers green tea.",
    speaker: [{ name: "Iri", confident: true }],
  });
  return service;
}

const scored = (results: Awaited<ReturnType<MemoryNodeService["search"]>>) =>
  new Map(results.map((result) => [result.slug, result.score]));

test("a name tag never enters the keyword text", async () => {
  await withTempDir(async (agentDir) => {
    const service = await speakerFixture(agentDir);

    // "mentions-aria" is found by the word Aria when it is *said*.
    const typed = await service.search({ query: "Aria green tea", mode: "keyword" });
    assert.ok(typed.some((result) => result.slug === "mentions-aria"));

    // The tag contributes no word of its own: "kettle" is the only term left,
    // and this memory does not contain it.
    const tagged = await service.search({
      query: "\\>>Aria: kettle",
      mode: "keyword",
    });
    assert.equal(
      tagged.some((result) => result.slug === "mentions-aria"),
      false,
    );
  });
});

test("a tag boosts memories attributed to that speaker", async () => {
  await withTempDir(async (agentDir) => {
    const service = await speakerFixture(agentDir);

    const plain = scored(await service.search({ query: "kettle", mode: "keyword" }));
    const tagged = await service.search({
      query: "\\>>Aria: kettle",
      mode: "keyword",
    });
    const boosted = scored(tagged);

    assert.ok((boosted.get("by-aria-about-tea") ?? 0) > (plain.get("by-aria-about-tea") ?? 0));
    assert.ok(
      tagged.find((result) => result.slug === "by-aria-about-tea")?.matchedFields
        .includes("speaker"),
    );
    // Another memory's attribution is untouched by a different name.
    assert.equal(boosted.get("mentions-aria"), plain.get("mentions-aria"));
  });
});

test("a name typed as text keeps ordinary scoring, tag or no tag", async () => {
  await withTempDir(async (agentDir) => {
    const service = await speakerFixture(agentDir);

    // Said as text, the name matches prose for everyone, attributed or not.
    const typed = await service.search({ query: "Aria", mode: "keyword" });
    const mentioned = typed.find((result) => result.slug === "mentions-aria");
    assert.ok(mentioned);
    assert.ok(mentioned.matchedFields.includes("body"));

    // A tag beside that text neither helps nor hurts a memory it is not
    // attributed to: only the words that were said are scored.
    const plain = scored(await service.search({ query: "green tea", mode: "keyword" }));
    const tagged = scored(
      await service.search({ query: "\\>>Aria: green tea", mode: "keyword" }),
    );
    assert.equal(tagged.get("mentions-aria"), plain.get("mentions-aria"));

    // Both at once on a memory that *is* attributed to her: one speaker boost,
    // and the typed name still scores as text.
    const both = await service.search({
      query: "\\>>Aria: four minutes",
      mode: "keyword",
    });
    const byAria = both.find((result) => result.slug === "by-aria-about-tea");
    assert.ok(byAria);
    assert.equal(
      byAria.matchedFields.filter((field) => field === "speaker").length,
      1,
    );
    assert.ok(byAria.matchedFields.includes("body"));
  });
});

test("a speaker match scores once per name, however many records carry it", async () => {
  await withTempDir(async (agentDir) => {
    const { service } = await makeService(agentDir);
    await service.add({
      slug: "one-record",
      title: "One record",
      type: "fact",
      body: "The kettle boils in four minutes.",
      speaker: [{ name: "Aria", confident: true }],
    });
    await service.add({
      slug: "three-records",
      title: "Three records",
      type: "fact",
      body: "The kettle boils in four minutes.",
      speaker: [
        { name: "Aria", confident: true },
        { name: "aria", confident: false },
        { name: "Aria", confident: true },
      ],
    });

    const results = await service.search({
      query: "\\>>Aria: kettle",
      mode: "keyword",
    });
    const bySlug = scored(results);
    assert.deepEqual(bySlug.get("one-record"), bySlug.get("three-records"));
  });
});

test("a query that is only a speaker tag is empty", async () => {
  await withTempDir(async (agentDir) => {
    const { service } = await makeService(agentDir);
    await assert.rejects(
      () => service.search({ query: "\\>>Aria:", mode: "keyword" }),
      /must not be empty/u,
    );
  });
});
