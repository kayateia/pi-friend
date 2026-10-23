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
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemorySchemaError,
  parseMemoryNode,
  parseMemoryNodeFile,
  serializeMemoryNode,
  validateMemoryNodeLocation,
} from "../../src/memory/schema.ts";

const VALID_FRONT_MATTER = `---
title: A warm memory
type: fact
speaker:
  - name: Aisling
    confident: true
    note: "fronting at the time"
agents:
  - Lime Pi
created: 2026-10-18T09:00:00Z
last_used: 2026-10-18T10:00:00Z
use_count: 2
decay_weight: 0.75
status: active
emotional_flavor: warm
tags:
  - friendship
supersedes: []
superseded_by: ""
links:
  - shared-ritual
source: "daily/2026-10-18.md"
edited: 2026-10-18T10:00:00Z
---
`;

const VALID_BODY = "\n**The memory.** Café ☕\r\nA line with --- inside.\r\n";

test("valid nodes parse into strict typed metadata with an exact body", () => {
  const node = parseMemoryNode(
    `${VALID_FRONT_MATTER}${VALID_BODY}`,
    "warm-memory",
  );

  assert.equal(node.slug, "warm-memory");
  assert.equal(node.frontMatter.title, "A warm memory");
  assert.equal(node.frontMatter.type, "fact");
  assert.deepEqual(node.frontMatter.speaker, [
    {
      name: "Aisling",
      confident: true,
      note: "fronting at the time",
    },
  ]);
  assert.deepEqual(node.frontMatter.agents, ["Lime Pi"]);
  assert.equal(node.frontMatter.use_count, 2);
  assert.equal(node.frontMatter.decay_weight, 0.75);
  assert.equal(node.frontMatter.edited, "2026-10-18T10:00:00Z");
  assert.equal(node.body, VALID_BODY);
});

test("optional source, speaker note, and edited timestamp may be omitted", () => {
  const text = VALID_FRONT_MATTER
    .replace('    note: "fronting at the time"\n', "")
    .replace('source: "daily/2026-10-18.md"\n', "")
    .replace("edited: 2026-10-18T10:00:00Z\n", "")
    .concat("\nbody\n");
  const node = parseMemoryNode(text, "warm-memory");

  assert.equal(node.frontMatter.source, "");
  assert.equal(node.frontMatter.edited, undefined);
  assert.equal("note" in node.frontMatter.speaker[0]!, false);
});

test("every approved type and status is accepted", () => {
  for (const type of MEMORY_TYPES) {
    for (const status of MEMORY_STATUSES) {
      const decay = status === "superseded" ? "0" : "1";
      const supersededBy =
        status === "superseded" ? "replacement" : '""';
      const text = VALID_FRONT_MATTER
        .replace("type: fact", `type: ${type}`)
        .replace("status: active", `status: ${status}`)
        .replace("decay_weight: 0.75", `decay_weight: ${decay}`)
        .replace('superseded_by: ""', `superseded_by: ${supersededBy}`)
        .concat("\nbody\n");

      const node = parseMemoryNode(text, "warm-memory");
      assert.equal(node.frontMatter.type, type);
      assert.equal(node.frontMatter.status, status);
    }
  }
});

test("the removed generic memory type is rejected", () => {
  const text = VALID_FRONT_MATTER.replace("type: fact", "type: memory")
    .concat("\nbody\n");
  assert.throws(() => parseMemoryNode(text, "warm-memory"), /must be one of/);
});

test("missing, malformed, and non-object front matter is rejected", () => {
  assert.throws(
    () => parseMemoryNode("No front matter\n", "warm-memory"),
    /must start with strict YAML front matter/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        "---\ntitle: [unclosed\n---\nbody\n",
        "warm-memory",
      ),
    /Invalid YAML front matter/,
  );
  assert.throws(
    () => parseMemoryNode("---\n- array\n---\nbody\n", "warm-memory"),
    /must be a YAML object/,
  );
});

test("unknown, duplicate, and missing fields are rejected", () => {
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("type: fact", "type: fact\nmystery: value")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /Unknown front-matter field "mystery"/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("title: A warm memory", "title: One\ntitle: Two")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /Invalid YAML front matter/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("title: A warm memory\n", "")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /Missing required front-matter field "title"/,
  );
});

test("invalid timestamps and contradictory time ordering are rejected", () => {
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace(
          "created: 2026-10-18T09:00:00Z",
          "created: 2026-02-30T09:00:00Z",
        ).concat("\nbody\n"),
        "warm-memory",
      ),
    /must be a valid ISO-8601 timestamp/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace(
          "last_used: 2026-10-18T10:00:00Z",
          "last_used: 2026-10-18T08:00:00Z",
        ).concat("\nbody\n"),
        "warm-memory",
      ),
    /last_used must not be earlier/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace(
          "edited: 2026-10-18T10:00:00Z",
          "edited: 2026-10-18T08:00:00Z",
        ).concat("\nbody\n"),
        "warm-memory",
      ),
    /edited must not be earlier/,
  );
});

test("numeric bounds are enforced", () => {
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("use_count: 2", "use_count: -1")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /nonnegative integer/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("decay_weight: 0.75", "decay_weight: 1.5")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /decay_weight.*0 to 1/,
  );
});

test("slug lists reject invalid values, duplicates, and self-reference", () => {
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace(
          "  - shared-ritual",
          "  - Invalid Slug",
        ).concat("\nbody\n"),
        "warm-memory",
      ),
    /Invalid slug/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace(
          "  - shared-ritual",
          "  - shared-ritual\n  - shared-ritual",
        ).concat("\nbody\n"),
        "warm-memory",
      ),
    /Duplicate value/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("supersedes: []", "supersedes:\n  - warm-memory")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /must not supersede itself/,
  );
});

test("supersession status and decay remain consistent", () => {
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace('superseded_by: ""', "superseded_by: newer")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /must have status "superseded"/,
  );
  assert.throws(
    () =>
      parseMemoryNode(
        VALID_FRONT_MATTER.replace("status: active", "status: superseded")
          .replace('superseded_by: ""', "superseded_by: newer")
          .concat("\nbody\n"),
        "warm-memory",
      ),
    /must have decay_weight 0/,
  );

  assert.doesNotThrow(() =>
    parseMemoryNode(
      VALID_FRONT_MATTER.replace("status: active", "status: superseded")
        .replace("decay_weight: 0.75", "decay_weight: 0")
        .concat("\nbody\n"),
      "warm-memory",
    ),
  );
});

test("location rules enforce staging and superseded semantics", () => {
  const active = parseMemoryNode(
    `${VALID_FRONT_MATTER}\nbody\n`,
    "warm-memory",
  );
  const candidateText = VALID_FRONT_MATTER.replace(
    "status: active",
    "status: candidate",
  ).concat("\nbody\n");
  const candidate = parseMemoryNode(candidateText, "warm-memory");
  const supersededText = VALID_FRONT_MATTER.replace(
    "status: active",
    "status: superseded",
  )
    .replace('superseded_by: ""', "superseded_by: newer")
    .replace("decay_weight: 0.75", "decay_weight: 0")
    .concat("\nbody\n");
  const superseded = parseMemoryNode(supersededText, "warm-memory");

  assert.throws(
    () =>
      validateMemoryNodeLocation(active, {
        kind: "staging-candidate",
        relativePath: "staging/warm-memory.md",
      }),
    /must have status "candidate"/,
  );
  for (const type of ["dream", "inner"] as const) {
    const quarantinedCandidate = parseMemoryNode(
      candidateText.replace("type: fact", `type: ${type}`),
      "warm-memory",
    );
    assert.throws(
      () =>
        validateMemoryNodeLocation(quarantinedCandidate, {
          kind: "staging-candidate",
          relativePath: "staging/warm-memory.md",
        }),
      /cannot be a staging candidate/,
    );
  }
  assert.throws(
    () =>
      validateMemoryNodeLocation(candidate, {
        kind: "node",
        relativePath: "nodes/warm-memory.md",
      }),
    /must not retain candidate status/,
  );
  assert.throws(
    () =>
      validateMemoryNodeLocation(active, {
        kind: "node",
        relativePath: "nodes/superseded/warm-memory.md",
      }),
    /must have status "superseded"/,
  );

  assert.doesNotThrow(() =>
    validateMemoryNodeLocation(candidate, {
      kind: "staging-candidate",
      relativePath: "staging/warm-memory.md",
    }),
  );
  assert.doesNotThrow(() =>
    validateMemoryNodeLocation(superseded, {
      kind: "node",
      relativePath: "nodes/superseded/warm-memory.md",
    }),
  );
});

test("node file parsing derives the slug and rejects documents", () => {
  const node = parseMemoryNodeFile(
    `${VALID_FRONT_MATTER}\nbody\n`,
    {
      kind: "node",
      relativePath: "nodes/warm-memory.md",
    },
  );
  assert.equal(node.slug, "warm-memory");

  assert.throws(
    () =>
      parseMemoryNodeFile("plain document\n", {
        kind: "document",
        relativePath: "docs/reference.md",
      }),
    /plain document/,
  );
});

test("serialization is deterministic and preserves the exact body", () => {
  const source = `${VALID_FRONT_MATTER}${VALID_BODY}`;
  const first = parseMemoryNode(source, "warm-memory");
  const serialized = serializeMemoryNode(first);
  const second = parseMemoryNode(serialized, "warm-memory");

  assert.equal(second.body, VALID_BODY);
  assert.deepEqual(second.frontMatter, first.frontMatter);
  assert.equal(serializeMemoryNode(second), serialized);
  assert.ok(serialized.startsWith("---\ntitle: A warm memory\n"));
  assert.ok(serialized.indexOf("source:") < serialized.indexOf("edited:"));
  assert.ok(serialized.endsWith(`---\n${VALID_BODY}`));
});

test("serializer rejects invalid programmatic nodes", () => {
  const node = parseMemoryNode(`${VALID_FRONT_MATTER}\nbody\n`, "warm-memory");
  node.frontMatter.title = "";

  assert.throws(() => serializeMemoryNode(node), MemorySchemaError);
});
