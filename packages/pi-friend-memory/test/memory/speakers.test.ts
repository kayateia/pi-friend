/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import type { MemorySpeaker } from "../../src/memory/schema.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { collapseSpeakers } from "../../src/memory/speakers.ts";
import { registerMemoryTools } from "../../src/tools/memory-tools.ts";
import { withTempDir } from "../helpers.ts";

const FIXED_TIME = new Date("2026-10-19T20:00:00.000Z");

/** Creates a service backed by an isolated memory tree. */
async function makeService(agentDir: string): Promise<MemoryNodeService> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return new MemoryNodeService(repository, () => FIXED_TIME);
}

/** Builds one attribution record, with no note unless one is given. */
function said(name: string, confident: boolean, note?: string): MemorySpeaker {
  return { name, confident, ...(note === undefined ? {} : { note }) };
}

test("both tools say an uncertain attribution needs a note", () => {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  registerMemoryTools(pi, () => undefined);

  type Schema = {
    description?: string;
    items?: Schema;
    properties?: Record<string, Schema>;
  };
  for (const name of ["memory_add", "memory_edit"]) {
    const definition = definitions.get(name) as { parameters: Schema };
    const confident = definition.parameters.properties?.speaker?.items
      ?.properties?.confident;
    // The collapse keeps a stated doubt and discards a bare one, so the note is
    // not decoration: without it the caveat does not survive a merge.
    assert.match(confident?.description ?? "", /give a note saying why/u);
    assert.match(confident?.description ?? "", /may be treated as confident/u);
  }
});

test("two confident records become one, with their notes joined", () => {
  const collapsed = collapseSpeakers([
    said("Aria", true, "explicit hold"),
    said("aria", true, "own the offline window"),
  ]);

  assert.equal(collapsed.length, 1);
  assert.deepEqual(collapsed[0], {
    name: "Aria",
    confident: true,
    note: "explicit hold; own the offline window",
  });
});

test("an uncertain record with no note is folded back to confident", () => {
  const notices: string[] = [];
  const collapsed = collapseSpeakers(
    [said("Destiny", true), said("Destiny", false)],
    { slug: "a-memory", reportDiscardedCaveat: (line) => notices.push(line) },
  );

  assert.deepEqual(collapsed, [{ name: "Destiny", confident: true }]);
  // The upgrade is visible rather than silent, and it names the memory.
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /uncertain attribution carried no note/);
  assert.match(notices[0] ?? "", /"a-memory"/);
});

test("an uncertain record with a note keeps the uncertainty", () => {
  const notices: string[] = [];
  const collapsed = collapseSpeakers(
    [said("Destiny", true, "decided"), said("Destiny", false, "relayed by Iri")],
    { slug: "a-memory", reportDiscardedCaveat: (line) => notices.push(line) },
  );

  assert.deepEqual(collapsed, [
    { name: "Destiny", confident: false, note: "decided; relayed by Iri" },
  ]);
  // Nothing was discarded, so nothing is reported.
  assert.deepEqual(notices, []);
});

test("two uncertain records stay uncertain even with no note", () => {
  const notices: string[] = [];
  const collapsed = collapseSpeakers(
    [said("Airi", false), said("Airi", false)],
    { reportDiscardedCaveat: (line) => notices.push(line) },
  );

  assert.deepEqual(collapsed, [{ name: "Airi", confident: false }]);
  assert.deepEqual(notices, []);
});

test("a stated doubt outranks a bare one in a longer list", () => {
  const collapsed = collapseSpeakers([
    said("Iri", true),
    said("Iri", false),
    said("Iri", false, "inferred from context"),
  ]);

  assert.deepEqual(collapsed, [
    { name: "Iri", confident: false, note: "inferred from context" },
  ]);
});

test("the order records arrive in does not change the outcome", () => {
  const records = [
    said("Infer", true),
    said("Aria", false, "guessed"),
    said("Infer", false),
  ];
  const forward = collapseSpeakers(records);
  const backward = collapseSpeakers([...records].reverse());

  assert.deepEqual(
    forward.map((speaker) => [speaker.name, speaker.confident]),
    backward.map((speaker) => [speaker.name, speaker.confident]),
  );
  assert.deepEqual(
    forward.map((speaker) => speaker.name),
    ["Infer", "Aria"],
    "first-seen order is kept",
  );
});

test("the first spelling of a name is the one kept", () => {
  assert.deepEqual(collapseSpeakers([said("AIRI", true), said("Airi", true)]), [
    { name: "AIRI", confident: true },
  ]);
});

test("whitespace is not a note, and nameless records are dropped", () => {
  const notices: string[] = [];
  const collapsed = collapseSpeakers(
    [said("Aria", true), said("Aria", false, "   "), said("  ", false, "stray")],
    { reportDiscardedCaveat: (line) => notices.push(line) },
  );

  assert.deepEqual(collapsed, [{ name: "Aria", confident: true }]);
  assert.equal(notices.length, 1, "a blank note counts as no note");
});

test("an identical note is not repeated", () => {
  assert.deepEqual(
    collapseSpeakers([said("Aria", true, "same"), said("Aria", true, "same")]),
    [{ name: "Aria", confident: true, note: "same" }],
  );
});

test("adding a memory with a repeated speaker stores one record", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const node = await service.add({
      title: "One Person Twice",
      type: "fact",
      body: "The kitchen faces east.",
      speaker: [said("Aisling", true), said("Aisling", true, "confirmed")],
    });

    assert.equal(node.frontMatter.speaker.length, 1);
    const stored = await service.read(node.slug);
    assert.deepEqual(stored?.frontMatter.speaker, [
      { name: "Aisling", confident: true, note: "confirmed" },
    ]);
  });
});

test("editing a memory collapses the replacement list", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const node = await service.add({
      title: "Editable",
      type: "fact",
      body: "Original body.",
      speaker: [said("Aisling", true)],
    });

    const edited = await service.edit(node.slug, {
      speaker: [
        said("Aria", true),
        said("Aria", false, "second-hand"),
        said("Aria", true),
      ],
    });

    assert.deepEqual(edited.frontMatter.speaker, [
      { name: "Aria", confident: false, note: "second-hand" },
    ]);
  });
});

test("staging a candidate collapses its speaker list", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const staged = await service.stageCandidate({
      title: "Candidate",
      type: "fact",
      body: "Staged body.",
      speaker: [said("Infer", true), said("infer", true)],
    });

    assert.deepEqual(staged.node.frontMatter.speaker, [
      { name: "Infer", confident: true },
    ]);
  });
});

test("merging two memories names each person once", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const target = await service.add({
      title: "Target",
      type: "fact",
      body: "First account.",
      speaker: [said("Destiny", true)],
    });
    const source = await service.add({
      title: "Source",
      type: "fact",
      body: "Second account.",
      speaker: [said("Destiny", false), said("Airi", true)],
    });

    const result = await service.mergeCandidates(target.slug, [source.slug]);

    assert.deepEqual(result.node.frontMatter.speaker, [
      { name: "Destiny", confident: true },
      { name: "Airi", confident: true },
    ]);
  });
});

test("a merge keeps a doubt that was given a reason", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const target = await service.add({
      title: "Target",
      type: "fact",
      body: "First account.",
      speaker: [said("Destiny", true)],
    });
    const source = await service.add({
      title: "Source",
      type: "fact",
      body: "Second account.",
      speaker: [said("Destiny", false, "relayed by Iri")],
    });

    const result = await service.mergeCandidates(target.slug, [source.slug]);

    assert.deepEqual(result.node.frontMatter.speaker, [
      { name: "Destiny", confident: false, note: "relayed by Iri" },
    ]);
  });
});
