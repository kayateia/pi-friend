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
import { buildMemoryDocumentIndex } from "../../src/memory/indexer.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

test("indexer distinguishes nodes, candidates, and documents", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(repository);
    await service.add({
      title: "Indexed Node",
      type: "fact",
      body: "A valid memory node.",
      speaker: [{ name: "Aisling", confident: true }],
      tags: ["indexed"],
    });

    await repository.store.writeTextFile(
      "staging/staged-note.md",
      `---
title: Staged Candidate
type: preference
speaker: []
agents: []
created: 2026-10-19T20:00:00Z
last_used: 2026-10-19T20:00:00Z
use_count: 0
decay_weight: 1
status: candidate
emotional_flavor: neutral
tags: []
supersedes: []
superseded_by: ""
links: []
source: ""
---

Candidate body.
`,
    );
    await repository.store.writeTextFile(
      "docs/reference.md",
      `---
title: Reference Notes
tags:
  - docs
---

Plain reference content.
`,
    );
    await repository.store.writeTextFile(
      "docs/heading.md",
      "# Heading Title\n\nHeading document body.\n",
    );

    const index = await buildMemoryDocumentIndex(repository.store);
    const byPath = new Map(index.map((file) => [file.relativePath, file]));

    const node = byPath.get("nodes/indexed-node.md");
    assert.equal(node?.kind, "node");
    assert.equal(node?.type, "fact");
    assert.equal(node?.status, "active");
    assert.equal(node?.decayWeight, 1);
    assert.deepEqual(node?.tags, ["indexed"]);

    const candidate = byPath.get("staging/staged-note.md");
    assert.equal(candidate?.kind, "staging-candidate");
    assert.equal(candidate?.status, "candidate");
    assert.equal(candidate?.type, "preference");

    const reference = byPath.get("docs/reference.md");
    assert.equal(reference?.kind, "document");
    assert.equal(reference?.title, "Reference Notes");
    assert.deepEqual(reference?.tags, ["docs"]);
    assert.match(reference?.body ?? "", /Plain reference content/);

    const heading = byPath.get("docs/heading.md");
    assert.equal(heading?.title, "Heading Title");
    assert.match(heading?.body ?? "", /Heading document body/);
  });
});

test("malformed node files remain searchable as documents", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    await writeFile(
      path.join(repository.store.paths.nodes, "broken.md"),
      `---
title: Broken Node
type: fact
---

Still searchable content.
`,
      "utf8",
    );

    const index = await buildMemoryDocumentIndex(repository.store);
    const broken = index.find(
      (file) => file.relativePath === "nodes/broken.md",
    );

    assert.equal(broken?.storageKind, "node");
    assert.equal(broken?.kind, "document");
    assert.equal(broken?.title, "Broken Node");
    assert.match(broken?.schemaError ?? "", /Missing required front-matter field/);
    assert.match(broken?.body ?? "", /Still searchable content/);
  });
});
