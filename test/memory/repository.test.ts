/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type {
  ParsedMemoryNode,
  MemoryStatus,
  MemoryType,
} from "../../src/memory/schema.ts";
import { MemorySchemaError } from "../../src/memory/schema.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { withTempDir } from "../helpers.ts";

/** Builds a valid node without touching the filesystem. */
function makeNode(options: {
  slug: string;
  body?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  supersededBy?: string;
}): ParsedMemoryNode {
  const status = options.status ?? "active";
  return {
    slug: options.slug,
    body: options.body ?? "\nA concise memory body.\n",
    frontMatter: {
      title: "Repository memory",
      type: options.type ?? "fact",
      speaker: [{ name: "Aisling", confident: true }],
      agents: ["Lime Pi"],
      created: "2026-10-18T09:00:00Z",
      last_used: "2026-10-18T09:00:00Z",
      use_count: 0,
      decay_weight: status === "superseded" ? 0 : 1,
      status,
      emotional_flavor: "warm",
      tags: ["repository"],
      supersedes: [],
      superseded_by: options.supersededBy ?? "",
      links: [],
      source: "",
    },
  };
}

test("canonical nodes round-trip through the repository", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const node = makeNode({
      slug: "warm-memory",
      body: "\nExact body with Café.\r\nNo normalization.\r\n",
    });

    await repository.write(node);
    const loaded = await repository.read("warm-memory");

    assert.deepEqual(loaded, node);
    assert.equal(
      await repository.read("missing-memory"),
      null,
    );
  });
});

test("repository lists only files belonging to the requested area", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });

    await repository.write(makeNode({ slug: "active-one" }));
    await repository.write(
      makeNode({
        slug: "candidate-one",
        status: "candidate",
      }),
      "staging",
    );
    await repository.write(
      makeNode({
        slug: "old-one",
        status: "superseded",
        supersededBy: "active-one",
      }),
      "superseded",
    );
    await repository.store.writeTextFile("docs/reference.md", "plain\n");

    assert.deepEqual(
      (await repository.list("canonical")).map((node) => node.slug),
      ["active-one"],
    );
    assert.deepEqual(
      (await repository.list("staging")).map((node) => node.slug),
      ["candidate-one"],
    );
    assert.deepEqual(
      (await repository.list("superseded")).map((node) => node.slug),
      ["old-one"],
    );
  });
});

test("repository enforces status rules for each area", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });

    await assert.rejects(
      () =>
        repository.write(
          makeNode({ slug: "not-a-candidate" }),
          "staging",
        ),
      /must have status "candidate"/,
    );
    await assert.rejects(
      () =>
        repository.write(
          makeNode({
            slug: "candidate-in-canon",
            status: "candidate",
          }),
        ),
      /must not retain candidate status/,
    );
    await assert.rejects(
      () =>
        repository.write(
          makeNode({
            slug: "superseded-in-canon",
            status: "superseded",
            supersededBy: "newer",
          }),
        ),
      /must live under nodes\/superseded/,
    );
    await assert.rejects(
      () =>
        repository.write(
          makeNode({
            slug: "dream-candidate",
            type: "dream",
            status: "candidate",
          }),
          "staging",
        ),
      /cannot be a staging candidate/,
    );
  });
});

test("repository refuses to treat plain documents as nodes", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await repository.store.writeTextFile("docs/reference.md", "plain\n");

    assert.equal(await repository.read("reference"), null);
    assert.deepEqual(await repository.list("canonical"), []);
  });
});

test("malformed node files fail with a schema error", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await writeFile(
      path.join(repository.store.paths.nodes, "broken.md"),
      "not front matter\n",
      "utf8",
    );

    await assert.rejects(
      () => repository.read("broken"),
      MemorySchemaError,
    );
  });
});
