/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { defaultRagInjectionConfig } from "../../src/memory/config.ts";
import { buildRagContext } from "../../src/memory/rag.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import type { AccessLogEntry } from "../../src/memory/store.ts";
import { withEnv, withTempDir } from "../helpers.ts";

const FLAG_ON = { PI_FRIEND_DEBUG_HOOKS: "1" };

/** Opens a store with three memories that a query can find. */
async function makeStore(agentDir: string): Promise<{
  repository: MemoryNodeRepository;
  service: MemoryNodeService;
}> {
  const repository = await MemoryNodeRepository.open({
    agentDir,
    homeDir: agentDir,
  });
  const service = new MemoryNodeService(repository);
  for (const name of ["Orchid", "Orchard", "Orchestra"]) {
    await service.add({
      title: name,
      type: "fact",
      body: `Notes about the ${name}.`,
      speaker: [{ name: "Iri", confident: true }],
    });
  }
  return { repository, service };
}

/** Reads every access-log entry, or an empty list when the file is absent. */
async function readLog(
  repository: MemoryNodeRepository,
): Promise<AccessLogEntry[]> {
  const text =
    (await repository.store.readTextFileIfExists("access-log")) ?? "";
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AccessLogEntry);
}

test("the access log is not written unless PI_FRIEND_DEBUG_HOOKS is set", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);

    const results = await service.search({ query: "orchid", mode: "keyword" });

    assert.equal(results.length, 1);
    assert.deepEqual(await readLog(repository), []);
  });
});

test("the log records the same hits with the flag on, and nothing more", async () => {
  await withTempDir(async (agentDir) => {
    const { repository, service } = await makeStore(agentDir);

    const quiet = await service.search({ query: "orch", mode: "keyword" });
    const loud = await withEnv(FLAG_ON, async () =>
      service.search({ query: "orch", mode: "keyword" }),
    );

    // Turning diagnostics on must not change what a search returns.
    assert.deepEqual(
      loud.map((result) => result.relativePath),
      quiet.map((result) => result.relativePath),
    );
    assert.equal((await readLog(repository)).length, loud.length);
  });
});

test("the log distinguishes a tool search from a recall pass", async () => {
  await withEnv(FLAG_ON, () =>
    withTempDir(async (agentDir) => {
      const { repository, service } = await makeStore(agentDir);

      await service.search({ query: "orchid", mode: "keyword" });
      await buildRagContext(service, "what about the orchid", {
        ...defaultRagInjectionConfig(),
        mode: "keyword",
      });

      const entries = await readLog(repository);
      const sources = new Set(entries.map((entry) => entry.source));

      assert.deepEqual([...sources].sort(), ["rag", "tool"]);
      // The tool call is the only one with exactly one row recorded before the
      // recall pass ran, so order alone identifies them.
      assert.equal(entries[0]?.source, "tool");
      assert.ok(entries.slice(1).every((entry) => entry.source === "rag"));
    }),
  );
});

test("deleting the log changes nothing", async () => {
  await withEnv(FLAG_ON, () =>
    withTempDir(async (agentDir) => {
      const { repository, service } = await makeStore(agentDir);

      const before = await service.search({ query: "orchestra", mode: "keyword" });
      assert.ok((await readLog(repository)).length > 0);

      // Out of band, the way a person would: the store refuses to remove or
      // replace its own append-only log through the API.
      await rm(path.join(repository.store.root, "access-log"));
      assert.deepEqual(await readLog(repository), []);

      const after = await service.search({ query: "orchestra", mode: "keyword" });
      assert.deepEqual(
        after.map((result) => result.relativePath),
        before.map((result) => result.relativePath),
      );
    }),
  );
});
