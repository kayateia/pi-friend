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
  MemoryNodeService,
  MemoryServiceError,
  slugifyTitle,
} from "../../src/memory/service.ts";
import {
  listHistoryVersions,
  readHistoryEntry,
} from "../../src/memory/history.ts";
import { withTempDir } from "../helpers.ts";

const FIXED_TIME = new Date("2026-10-19T20:00:00.000Z");

/** Creates a service backed by an isolated memory tree. */
async function makeService(
  agentDir: string,
  now: () => Date = () => FIXED_TIME,
): Promise<MemoryNodeService> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  return new MemoryNodeService(repository, now);
}

test("titles become safe lowercase slugs", () => {
  assert.equal(slugifyTitle("Café & Warmth"), "cafe-warmth");
  assert.equal(slugifyTitle("  A / B  "), "a-b");
  assert.equal(slugifyTitle("💛"), "memory");
});

test("add creates an active node with schema defaults", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const node = await service.add({
      title: "A Warm Memory",
      type: "fact",
      body: "The kitchen window faces east.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    assert.equal(node.slug, "a-warm-memory");
    assert.equal(node.body, "\nThe kitchen window faces east.\n");
    assert.equal(node.frontMatter.created, FIXED_TIME.toISOString());
    assert.equal(node.frontMatter.last_used, FIXED_TIME.toISOString());
    assert.equal(node.frontMatter.status, "active");
    assert.equal(node.frontMatter.decay_weight, 1);
    assert.equal(node.frontMatter.emotional_flavor, "neutral");
    assert.deepEqual(await service.read(node.slug), node);
  });
});

test("automatic slugs gain a deterministic suffix on collision", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const input = {
      title: "Same Title",
      type: "event" as const,
      body: "One event.",
      speaker: [{ name: "Aisling", confident: true }],
    };

    const first = await service.add(input);
    const second = await service.add(input);
    const third = await service.add(input);

    assert.equal(first.slug, "same-title");
    assert.equal(second.slug, "same-title-2");
    assert.equal(third.slug, "same-title-3");
  });
});

test("explicit slug collisions fail instead of overwriting", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const input = {
      title: "Explicit",
      type: "preference" as const,
      body: "Explicit slug.",
      speaker: [{ name: "Aisling", confident: true }],
      slug: "chosen-slug",
    };

    await service.add(input);
    await assert.rejects(() => service.add(input), MemoryServiceError);
  });
});

test("read returns null for missing nodes", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    assert.equal(await service.read("missing"), null);
  });
});

test("schema validation remains active through the service", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () =>
        service.add({
          title: "Broken Link",
          type: "fact",
          body: "Body.",
          speaker: [{ name: "Aisling", confident: true }],
          links: ["Invalid Slug"],
        }),
      /Invalid slug/,
    );
  });
});

test("edit preserves creation state and archives the version it replaced", async () => {
  await withTempDir(async (agentDir) => {
    let currentTime = FIXED_TIME;
    const service = await makeService(agentDir, () => currentTime);
    const created = await service.add({
      title: "Original Title",
      type: "fact",
      body: "Original body.",
      speaker: [{ name: "Aisling", confident: true }],
      tags: ["old"],
    });

    currentTime = new Date("2026-10-19T21:00:00.000Z");
    const edited = await service.edit(created.slug, {
      title: "Updated Title",
      body: "Updated body.",
      tags: ["new"],
      reason: "Corrected the wording",
    });

    assert.equal(edited.frontMatter.created, FIXED_TIME.toISOString());
    assert.equal(edited.frontMatter.edited, currentTime.toISOString());
    assert.equal(edited.frontMatter.use_count, created.frontMatter.use_count);
    assert.equal(
      edited.frontMatter.decay_weight,
      created.frontMatter.decay_weight,
    );
    assert.equal(edited.frontMatter.title, "Updated Title");
    assert.deepEqual(edited.frontMatter.tags, ["new"]);
    assert.match(edited.body, /Updated body\./);
    assert.doesNotMatch(edited.body, /## audit/);
    assert.deepEqual(await service.read(created.slug), edited);

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const versions = await listHistoryVersions(
      repository.store,
      "edited",
      created.slug,
    );
    assert.deepEqual(versions, [
      `history/edited/${created.slug}/${currentTime.toISOString()}.md`,
    ]);
    const previous = await readHistoryEntry(
      repository.store,
      versions[0] ?? "",
      created.slug,
    );
    assert.ok(previous);
    // The file holds the memory as it was, not as it became.
    assert.match(previous.body, /Original body\./);
    assert.doesNotMatch(previous.body, /Updated body\./);
    assert.equal(previous.frontMatter.title, "Original Title");
    assert.deepEqual(previous.frontMatter.tags, ["old"]);
    // The reason describes the edit that replaced this version.
    assert.equal(previous.frontMatter.history_reason, "Corrected the wording");
  });
});

test("edit requires an existing node and at least one changed field", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () => service.edit("missing", { title: "Nope" }),
      MemoryServiceError,
    );

    const node = await service.add({
      title: "Existing",
      type: "fact",
      body: "Body.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await assert.rejects(
      () => service.edit(node.slug, { reason: "No actual change" }),
      /No memory fields/,
    );
  });
});

test("delete archives the node as it was, then removes it from nodes", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const original = await service.add({
      title: "Delete Me",
      type: "fact",
      body: "This fact will be deleted.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    const deleted = await service.delete(original.slug);

    assert.equal(deleted.slug, original.slug);
    assert.equal(deleted.historyPath, `history/deleted/${original.slug}.md`);
    assert.equal(await service.read(original.slug), null);

    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const archived = await readHistoryEntry(
      repository.store,
      deleted.historyPath,
      original.slug,
    );
    assert.ok(archived);
    // Content as it was: active, its own weight, its own body, no tombstone
    // markers and no audit line describing the deletion.
    assert.equal(archived.frontMatter.status, "active");
    assert.equal(archived.frontMatter.decay_weight, 1);
    assert.match(archived.body, /This fact will be deleted\./);
    assert.doesNotMatch(archived.body, /superseded|memory_delete/);
  });
});

test("delete rejects ambiguous substring matches but accepts an exact slug", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const first = await service.add({
      title: "Shared First",
      type: "event",
      body: "A shared topic.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    const second = await service.add({
      title: "Shared Second",
      type: "event",
      body: "Another shared topic.",
      speaker: [{ name: "Aisling", confident: true }],
    });

    await assert.rejects(
      () => service.delete("shared"),
      /matches multiple memories/,
    );
    assert.ok(await service.read(first.slug));
    assert.ok(await service.read(second.slug));

    await service.delete(first.slug);
    assert.equal(await service.read(first.slug), null);
    assert.ok(await service.read(second.slug));
  });
});

test("restore copies the archived version back and consumes the entry", async () => {
  await withTempDir(async (agentDir) => {
    let currentTime = FIXED_TIME;
    const service = await makeService(agentDir, () => currentTime);
    const original = await service.add({
      title: "Restore Me",
      type: "preference",
      body: "A restorable preference.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.delete(original.slug);

    currentTime = new Date("2026-10-20T22:00:00.000Z");
    const restored = await service.restore(original.slug);
    assert.equal(restored.slug, original.slug);
    assert.equal(restored.node.frontMatter.status, "active");
    assert.equal(restored.node.frontMatter.decay_weight, 1);
    assert.equal(restored.node.frontMatter.edited, currentTime.toISOString());
    assert.match(restored.node.body, /A restorable preference\./);
    assert.doesNotMatch(restored.node.body, /memory_restore/);
    assert.deepEqual(await service.read(original.slug), restored.node);

    // The entry is consumed: a second restore has nothing to copy.
    await assert.rejects(
      () => service.restore(original.slug),
      /No deleted memory or stored version named/,
    );
  });
});

test("restore replaces a live node with the same slug and archives it", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const original = await service.add({
      title: "Reused Name",
      type: "fact",
      body: "Original content.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.delete(original.slug);

    // A second memory takes the name while the first is only in history.
    const replacement = await service.add({
      slug: original.slug,
      title: "Reused Name",
      type: "fact",
      body: "Newer content under the same name.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    assert.equal(replacement.slug, original.slug);

    const restored = await service.restore(original.slug);
    assert.equal(restored.replaced, true);
    assert.match(restored.node.body, /Original content\./);
    assert.doesNotMatch(restored.node.body, /Newer content/);

    // The displaced text is not lost: it is stored as a version.
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const versions = await listHistoryVersions(
      repository.store,
      "edited",
      original.slug,
    );
    const archived = await readHistoryEntry(
      repository.store,
      versions[versions.length - 1] ?? "",
      original.slug,
    );
    assert.ok(archived);
    assert.match(archived.body, /Newer content under the same name/);
    assert.equal(
      archived.frontMatter.history_reason,
      "replaced by memory_restore",
    );
  });
});

test("restore strips history fields from the copy it writes back", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const original = await service.add({
      title: "Bare Restore",
      type: "fact",
      body: "Plain content.",
      speaker: [{ name: "Aisling", confident: true }],
    });
    await service.delete(original.slug);

    const restored = await service.restore(original.slug);
    assert.equal(restored.replaced, false);
    assert.equal(restored.node.frontMatter.history_reason, undefined);
    assert.equal(restored.node.frontMatter.history_conflict, undefined);
    assert.equal(restored.node.frontMatter.history_children, undefined);
  });
});

test("restoring a slug with no history entry reports it", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    await assert.rejects(
      () => service.restore("never-existed"),
      /No deleted memory or stored version named/,
    );
  });
});

test("exclusive operations are re-entrant and block other mutations", async () => {
  await withTempDir(async (agentDir) => {
    const service = await makeService(agentDir);
    const entered = deferred();
    const release = deferred();

    const exclusive = service.runExclusive(async () => {
      const node = await service.add({
        title: "Inside Exclusive",
        type: "fact",
        body: "Nested service calls must not deadlock.",
        speaker: [{ name: "Aisling", confident: true }],
      });
      entered.resolve();
      await release.promise;
      return node.slug;
    });
    await entered.promise;

    let externalFinished = false;
    const external = service
      .add({
        title: "After Exclusive",
        type: "fact",
        body: "This write waits for the exclusive operation.",
        speaker: [{ name: "Aisling", confident: true }],
      })
      .then((node) => {
        externalFinished = true;
        return node;
      });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(externalFinished, false);

    release.resolve();
    assert.equal(await exclusive, "inside-exclusive");
    assert.equal((await external).slug, "after-exclusive");
  });
});

test("separate service instances sharing a root serialize mutations", async () => {
  await withTempDir(async (agentDir) => {
    const first = await makeService(agentDir);
    const second = await makeService(agentDir);
    const entered = deferred();
    const release = deferred();

    const exclusive = first.runExclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let secondFinished = false;
    const write = second
      .add({
        title: "Cross Conversation",
        type: "fact",
        body: "All memory services for one root share ordering.",
        speaker: [{ name: "Aisling", confident: true }],
      })
      .then((node) => {
        secondFinished = true;
        return node;
      });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondFinished, false);

    release.resolve();
    await exclusive;
    assert.equal((await write).slug, "cross-conversation");
  });
});

/** Creates a manually resolved promise gate. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
