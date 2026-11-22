/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { listHistoryVersions } from "../../src/memory/history.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import {
  validateLinks,
  validateMemory,
  validateMemoryFiles,
} from "../../src/memory/validation.ts";
import { withTempDir } from "../helpers.ts";

const NOW = new Date("2026-11-22T00:00:00.000Z");

/** Opens a service in a temporary store. */
async function makeService(
  agentDir: string,
): Promise<MemoryNodeService> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return new MemoryNodeService(repository, () => NOW);
}

/** Creates one plain canonical memory and returns its slug. */
async function makeMemory(
  service: MemoryNodeService,
  slug: string,
): Promise<string> {
  const node = await service.add({
    slug,
    title: slug,
    type: "fact",
    body: `Body of ${slug}.`,
    speaker: [],
  });
  return node.slug;
}

test("a link must name an existing memory", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () =>
        service.add({
          title: "Kettle",
          type: "fact",
          body: "The kettle is blue.",
          speaker: [],
          links: ["no-such-memory"],
        }),
      /Link "no-such-memory" in kettle does not name an existing memory/u,
    );
    // The refused write left nothing behind.
    assert.equal(await service.read("kettle"), null);
  });
});

test("a link to itself is refused", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () =>
        service.add({
          slug: "kettle",
          title: "Kettle",
          type: "fact",
          body: "The kettle is blue.",
          speaker: [],
          links: ["kettle"],
        }),
      /must not link to itself/u,
    );
  });
});

test("a link to a staging candidate is refused", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const staged = await service.stageCandidate({
      title: "Staged",
      type: "fact",
      body: "Not a memory yet.",
      speaker: [],
    });

    await assert.rejects(
      () =>
        service.add({
          title: "Kettle",
          type: "fact",
          body: "The kettle is blue.",
          speaker: [],
          links: [staged.node.slug],
        }),
      /does not name an existing memory/u,
    );
  });
});

test("an edit refuses a missing link and writes no history entry", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const slug = await makeMemory(service, "kettle");

    await assert.rejects(
      () => service.edit(slug, { links: ["ghost"] }),
      /Link "ghost" in kettle does not name an existing memory/u,
    );
    assert.deepEqual(
      await listHistoryVersions(service.store, "edited", slug),
      [],
    );
  });
});

test("staging drops a link that names nothing, silently", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await makeMemory(service, "kettle");

    const staged = await service.stageCandidate({
      title: "Lantern",
      type: "fact",
      body: "The lantern hangs by the door.",
      speaker: [],
      links: ["kettle", "no-such-memory"],
    });

    assert.deepEqual(staged.node.frontMatter.links, ["kettle"]);
  });
});

test("a merge points incoming links at the surviving memory", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const target = await makeMemory(service, "warm-kitchen");
    const sourceOne = await makeMemory(service, "cool-kitchen");
    const sourceTwo = await makeMemory(service, "cold-kitchen");

    // A memory that points at both absorbed nodes: after the merge it should
    // point at the target once, not twice.
    const observer = await service.add({
      title: "Observer",
      type: "fact",
      body: "The observer remembers both kitchens.",
      speaker: [],
      links: [sourceOne, sourceTwo],
    });

    await service.mergeCandidates(target, [sourceOne, sourceTwo]);

    const after = await service.read(observer.slug);
    assert.deepEqual(after?.frontMatter.links, [target]);
  });
});

test("deleting a memory removes the links that pointed at it", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const target = await makeMemory(service, "kettle");
    const other = await makeMemory(service, "teapot");
    const observer = await service.add({
      title: "Observer",
      type: "fact",
      body: "The observer remembers both.",
      speaker: [],
      links: [target, other],
    });

    await service.delete(target);

    const after = await service.read(observer.slug);
    assert.deepEqual(after?.frontMatter.links, [other]);
  });
});

test("the validator reports a dangling link, and only the validator does", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    // Written around the service: this is a store that already contains the
    // defect the checker exists to find.
    await repository.store.writeTextFile(
      "nodes/old.md",
      [
        "---",
        "title: Old",
        "type: fact",
        "speaker: []",
        "agents: []",
        "created: 2026-11-01T00:00:00Z",
        "last_used: 2026-11-01T00:00:00Z",
        "use_count: 0",
        "decay_weight: 1",
        "status: active",
        "emotional_flavour: neutral",
        "tags: []",
        "links:",
        "  - gone-memory",
        "sources: []",
        "---",
        "",
        "A memory with a dead pointer.",
      ].join("\n"),
    );

    const schema = await validateMemoryFiles(repository.store);
    assert.deepEqual(schema.failures, []);

    const links = await validateLinks(repository.store);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.path, "nodes/old.md");
    assert.match(links[0]?.error ?? "", /Dangling link "gone-memory"/u);

    const combined = await validateMemory(repository.store);
    assert.equal(combined.failures.length, 1);
  });
});
