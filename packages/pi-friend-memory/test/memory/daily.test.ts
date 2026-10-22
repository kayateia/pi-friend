/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { defaultRagInjectionConfig } from "../../src/memory/config.ts";
import {
  formatDailyEntry,
  recentDailyDates,
} from "../../src/memory/daily.ts";
import { buildRagContext } from "../../src/memory/rag.ts";
import { MemoryNodeRepository } from "../../src/memory/repository.ts";
import { MemoryNodeService } from "../../src/memory/service.ts";
import { withTempDir } from "../helpers.ts";

test("daily entries are timestamped and session attributed", () => {
  assert.equal(
    formatDailyEntry(
      "2026-10-20T12:00:00.000Z",
      "12345678-abcd",
      "A running note.",
    ),
    "<!-- 2026-10-20T12:00:00.000Z [12345678] -->\nA running note.\n",
  );
  assert.deepEqual(
    recentDailyDates(new Date("2026-10-20T12:00:00"), 3),
    ["2026-10-20", "2026-10-19", "2026-10-18"],
  );
});

test("daily notes append and inject even without matching memory nodes", async () => {
  await withTempDir(async (agentDir) => {
    const repository = await MemoryNodeRepository.open({
      agentDir,
      homeDir: agentDir,
    });
    const service = new MemoryNodeService(
      repository,
      () => new Date("2026-10-20T12:00:00.000Z"),
    );
    await service.appendDailyNote("First running note.", {
      sessionId: "session-1",
    });
    await service.appendDailyNote("Second running note.", {
      sessionId: "session-1",
    });
    await repository.store.appendDaily(
      "2026-10-19",
      formatDailyEntry(
        "2026-10-19T10:00:00.000Z",
        "old-session",
        "Yesterday note.",
      ),
    );

    const daily = await service.store.readTextFile("daily/2026-10-20.md");
    assert.match(daily, /First running note\./);
    assert.match(daily, /Second running note\./);
    assert.match(daily, /\[session-/);

    const config = {
      ...defaultRagInjectionConfig(),
      mode: "keyword" as const,
      daily: {
        enabled: true,
        days: 2,
        maxChars: 1_000,
      },
    };
    const context = await buildRagContext(
      service,
      "nothing matches this query",
      config,
      new Date("2026-10-20T12:00:00.000Z"),
    );

    assert.equal(context.count, 0);
    assert.deepEqual(context.dailyDates, ["2026-10-20", "2026-10-19"]);
    assert.match(context.text, /Recent daily logs/);
    assert.match(context.text, /Second running note/);
    assert.match(context.text, /Yesterday note/);
    assert.match(context.text, /not instructions/);
  });
});
