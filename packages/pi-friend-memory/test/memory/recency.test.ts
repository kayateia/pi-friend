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
import {
  buildRagContext,
  describeAge,
  formatLocalStamp,
} from "../../src/memory/rag.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import type { ParsedMemoryNode } from "../../src/memory/schema.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

const NOW = new Date("2026-11-15T17:00:00.000Z");

/** Builds one node, with the dates the recency window is judged by. */
function makeNode(options: {
  slug: string;
  created: string;
  edited?: string;
  title?: string;
  body?: string;
  status?: "active" | "candidate";
  type?: ParsedMemoryNode["frontMatter"]["type"];
}): ParsedMemoryNode {
  return {
    slug: options.slug,
    body: `\n${options.body ?? `Body of ${options.slug}.`}\n`,
    frontMatter: {
      title: options.title ?? options.slug,
      type: options.type ?? "fact",
      speaker: [{ name: "Iri", confident: true }],
      agents: [],
      created: options.created,
      last_used: options.created,
      use_count: 0,
      decay_weight: 1,
      status: options.status ?? "active",
      emotional_flavour: "matter-of-fact",
      tags: [],
      links: [],
      sources: [],
      ...(options.edited === undefined ? {} : { edited: options.edited }),
    },
  };
}

/** Opens a store, and a service over it. */
async function makeStore(agentDir: string): Promise<{
  repository: MemoryNodeRepository;
  service: MemoryNodeService;
}> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return { repository, service: new MemoryNodeService(repository) };
}

/** Runs the recency pass with a keyword recall pass beside it. */
async function build(
  service: MemoryNodeService,
  query: string,
  recency: Partial<ReturnType<typeof defaultRecencyInjectionConfig>> = {},
) {
  return buildRagContext(
    service,
    query,
    { ...defaultRagInjectionConfig(), mode: "keyword", limit: 5 },
    { ...defaultRecencyInjectionConfig(), mode: "keyword", ...recency },
    { now: NOW },
  );
}

test("eligibility is the union of the age window and the newest N", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    // One hour old, two hours old, three hours old.
    await repository.write(makeNode({ slug: "recent", created: "2026-11-15T16:00:00.000Z" }));
    await repository.write(makeNode({ slug: "middle", created: "2026-11-15T15:00:00.000Z" }));
    await repository.write(makeNode({ slug: "oldest", created: "2026-11-15T14:00:00.000Z" }));

    const pool = await service.recentPool({
      maxAgeSeconds: 3_600,
      lastN: 2,
      now: NOW,
    });

    assert.deepEqual(
      pool.map((entry) => [entry.slug, entry.reason]),
      [
        ["middle", "count"],
        ["recent", "both"],
      ],
      "the window admits the newest, the floor admits the next one, and the order is chronological",
    );
  });
});

test("a memory with no relevance is still injected because it is recent", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({
        slug: "orchid-notes",
        created: "2026-11-15T16:55:00.000Z",
        title: "Orchid notes",
        body: "The orchid is in the study.",
      }),
    );

    const context = await build(service, "quarterly invoicing spreadsheet");

    assert.equal(context.recency.count, 1);
    assert.equal(context.recall.count, 0);
    const text = context.blocks[0]?.text ?? "";
    assert.match(text, /## Recently/);
    assert.match(text, /### Orchid notes/);
    // The date is the explanation: a "why recent" line said nothing it had not
    // already said, and the rule and rank live in the diagnostic.
    assert.doesNotMatch(text, /Why recent/);
    // Nothing matched, so there is no Recalled section to sit beneath it.
    assert.doesNotMatch(text, /## Recalled memories/);
  });
});

test("a memory recalled for relevance is not repeated in Recently", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({
        slug: "orchid",
        created: "2026-11-15T16:55:00.000Z",
        body: "The orchid is in the study.",
      }),
    );

    const context = await build(service, "orchid");

    assert.equal(context.recall.count, 1);
    assert.equal(context.recency.count, 0, "one section only, and Recalled wins");
    assert.doesNotMatch(context.blocks[0]?.text ?? "", /## Recently/);
    // Recalled slugs leave the pool before the search, so a slot is not spent
    // on a memory the dedupe would drop anyway.
    assert.equal(context.diagnostics.recency?.results.length, 0);
  });
});

test("a corpus built for the turn is what the pool reads", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({ slug: "recent", created: "2026-11-15T16:55:00.000Z" }),
    );
    await repository.write(
      makeNode({ slug: "other", created: "2026-11-15T16:50:00.000Z" }),
    );

    const files = await service.searchFiles();
    // The pool is filtered from the supplied corpus rather than re-read from
    // disk, which is what lets one turn pay for one index build.
    const pool = await service.recentPool({
      maxAgeSeconds: 86_400,
      lastN: 8,
      now: NOW,
      files: files.filter((file) => file.slug !== "other"),
    });

    assert.deepEqual(pool.map((entry) => entry.slug), ["recent"]);
  });
});

test("an entry carries its date and no explanation beside it", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({
        slug: "edited-recently",
        created: "2026-11-10T09:00:00.000Z",
        edited: "2026-11-15T16:30:00.000Z",
        title: "Corrected account",
      }),
    );

    const context = await build(service, "nothing matches");

    const text = context.recency.text;
    // The label follows `edited ?? created`, so a memory edited recently dates
    // from the edit rather than from when it was first written.
    assert.match(text, /edited \w{3} 2026-11-15 \d{2}:30:00 \(30 minutes ago\)/u);
    assert.doesNotMatch(text, /Why recent/);
    // The rule that admitted it is still reported, where it can be asked for.
    assert.equal(context.diagnostics.recency?.results[0]?.reason, "both");
  });
});

test("the section reads as a timeline even though selection is by relevance", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({
        slug: "older",
        created: "2026-11-15T15:00:00.000Z",
        body: "Mention of the lantern.",
      }),
    );
    await repository.write(
      makeNode({
        slug: "newer",
        created: "2026-11-15T16:00:00.000Z",
        body: "Lantern and kettle.",
      }),
    );

    const context = await build(service, "nothing here matches either account");
    const text = context.recency.text;

    assert.ok(
      text.indexOf("### older") < text.indexOf("### newer"),
      "the older entry is rendered first",
    );
    // Rendered in system local time, so the wall clock is not pinned — the
    // date and the age beside it are.
    assert.match(text, /created \w{3} 2026-11-15 \d{2}:00:00 \(2 hours ago\)/u);
  });
});

test("a recent candidate keeps the unverified marker and carries no tier", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({
        slug: "staged",
        created: "2026-11-15T16:30:00.000Z",
        status: "candidate",
        title: "A staged thought",
      }),
      "staging",
    );

    const context = await build(service, "unrelated words entirely");

    const text = context.recency.text;
    assert.match(
      text,
      /Candidate - unverified · created \w{3} 2026-11-15 \d{2}:30:00/u,
    );
    assert.match(text, /staging\/staged\.md/);
    assert.doesNotMatch(text, /Tier:/, "decay weight has no business here");
  });
});

test("two positions mean two blocks, each with its own header", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({ slug: "recent", created: "2026-11-15T16:55:00.000Z" }),
    );
    await repository.write(
      makeNode({
        slug: "recalled",
        created: "2026-10-01T00:00:00.000Z",
        body: "The orchid fact.",
      }),
    );

    const context = await build(service, "orchid", { position: 0 });

    assert.equal(context.blocks.length, 2);
    assert.equal(context.blocks[0]?.position, 0);
    assert.match(context.blocks[0]?.text ?? "", /## Recently/);
    assert.doesNotMatch(context.blocks[0]?.text ?? "", /## Recalled/);
    assert.equal(context.blocks[1]?.position, -1);
    assert.match(context.blocks[1]?.text ?? "", /## Recalled memories/);
    assert.doesNotMatch(context.blocks[1]?.text ?? "", /## Recently/);
  });
});

test("one position means one block holding both sections", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({ slug: "recent", created: "2026-11-15T16:55:00.000Z" }),
    );
    await repository.write(
      makeNode({
        slug: "recalled",
        created: "2026-10-01T00:00:00.000Z",
        body: "The orchid fact.",
      }),
    );

    const context = await build(service, "orchid");

    assert.equal(context.blocks.length, 1);
    const text = context.blocks[0]?.text ?? "";
    assert.ok(text.startsWith("<pi-friend-memory>\n"));
    assert.ok(text.endsWith("\n</pi-friend-memory>"));
    assert.equal(text.match(/<pi-friend-memory>/gu)?.length, 1);
    assert.ok(text.indexOf("## Recently") < text.indexOf("## Recalled memories"));
  });
});

test("a recency pass moves no counters and writes no access log", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({ slug: "watched", created: "2026-11-15T16:55:00.000Z" })
    );

    const before = await service.read("watched");
    await build(service, "watched");
    const after = await service.read("watched");

    assert.equal(after?.frontMatter.use_count, before?.frontMatter.use_count);
    assert.equal(after?.frontMatter.last_used, before?.frontMatter.last_used);
    assert.equal(
      (await repository.store.readTextFileIfExists("access-log"))?.trim(),
      "",
      "reading to describe is not a search anyone made",
    );
  });
});

test("the section is absent when recency is disabled", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);
    await repository.write(
      makeNode({ slug: "recent", created: "2026-11-15T16:55:00.000Z" }),
    );

    const context = await build(service, "anything", { enabled: false });

    assert.equal(context.blocks.length, 0);
    assert.equal(context.recency.count, 0);
    assert.equal(context.diagnostics.recency, undefined);
  });
});

test("local stamps and ages read the way a person says them", () => {
  const now = new Date("2026-11-15T17:00:00.000Z");

  assert.match(formatLocalStamp("2026-11-15T16:48:00.000Z", now), /\(12 minutes ago\)$/u);
  assert.equal(describeAge(0), "0 seconds ago");
  assert.equal(describeAge(1_000), "1 second ago");
  assert.equal(describeAge(90_000), "2 minutes ago");
  assert.equal(describeAge(3_600_000), "1 hour ago");
  assert.equal(describeAge(86_400_000 * 2), "2 days ago");
  assert.match(
    formatLocalStamp("not-a-date", now),
    /unreadable timestamp/u,
  );
});
