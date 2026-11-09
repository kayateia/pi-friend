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
import {
  formatValidationReport,
  validateMemoryFiles,
} from "../../src/memory/validation.ts";
import { withTempDir } from "../helpers.ts";

/** A valid node file. */
function node(slug: string, flavour = "warm"): string {
  return `---
title: ${slug}
type: fact
speaker: []
agents: []
created: 2026-10-01T00:00:00Z
last_used: 2026-10-01T00:00:00Z
use_count: 0
decay_weight: 1
status: active
emotional_flavour: ${flavour}
tags: []
supersedes: []
superseded_by: ""
links: []
source: ""
---

Body of ${slug}.
`;
}

test("every stored file is checked, and every failure is named", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const store = repository.store;

    await store.writeTextFile("nodes/good.md", node("good"));
    await store.writeTextFile("staging/candidate.md", node("candidate"));
    // Live-area rules: a candidate is fine in staging, but `nonsense` is not a
    // status anywhere.
    await store.writeTextFile(
      "nodes/bad-status.md",
      node("bad-status").replace("status: active", "status: nonsense"),
    );
    // History keeps a node as it was, so a history field is allowed there.
    await store.writeTextFile(
      "history/edited/good/2026-10-02T00:00:00.000Z.md",
      node("good").replace('source: ""', 'source: ""\nhistory_reason: "tidy"'),
    );
    await store.writeTextFile(
      "history/deleted/old.md",
      node("old").replace("type: fact", "type: recollection"),
    );

    const report = await validateMemoryFiles(store);

    // Listing an area stops at the first bad file; the validator does not.
    assert.equal(report.scanned, 5);
    assert.deepEqual(
      report.failures.map((failure) => failure.path),
      ["nodes/bad-status.md", "history/deleted/old.md"],
    );
    assert.match(report.failures[0]?.error ?? "", /status/u);
    assert.match(report.failures[1]?.error ?? "", /type/u);
  });
});

test("a report reads as a check, not a scare", () => {
  assert.equal(
    formatValidationReport({ scanned: 3, failures: [] }),
    "pi-friend memory: 3 files checked, all valid.",
  );
  assert.equal(
    formatValidationReport({ scanned: 1, failures: [] }),
    "pi-friend memory: 1 file checked, all valid.",
  );

  const failing = formatValidationReport({
    scanned: 4,
    failures: [{ path: "nodes/bad.md", error: "status is nonsense" }],
  });
  assert.match(failing, /4 files checked, 1 could not be parsed/u);
  assert.match(failing, /nodes\/bad\.md: status is nonsense/u);

  // Past twenty the message stops being read, so the count carries the rest.
  const many = formatValidationReport({
    scanned: 30,
    failures: Array.from({ length: 25 }, (_, index) => ({
      path: `nodes/bad-${index}.md`,
      error: "bad",
    })),
  });
  assert.match(many, /25 could not be parsed/u);
  assert.match(many, /… and 5 more/u);
});
