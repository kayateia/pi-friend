#!/usr/bin/env node
/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 *
 * Converts the legacy `emotional_flavor` front-matter key to `emotional_flavour`.
 *
 * The extension does this itself at the top of `session_start`, once per store,
 * before anything parses a node. This script exists for the case that leaves: a
 * file that arrives *after* the store was migrated — restored from an old
 * snapshot, copied from another instance — which the parser refuses by name and
 * which no startup will convert, because the store is already marked as done.
 *
 * Usage:
 *   node scripts/migrate-flavour.ts --check   # report, change nothing
 *   node scripts/migrate-flavour.ts           # rewrite and mark
 *
 * The store is the one the extension would use: `PI_CODING_AGENT_DIR` and the
 * `pi-friend-memory.yml` in it.
 */

import { MemoryNodeRepository } from "../src/memory/repository.ts";
import {
  runPendingMigrations,
  type MigrationOutcome,
} from "../src/memory/migrations.ts";

function summarise(outcome: MigrationOutcome): string {
  const lines = [
    `${outcome.status}: examined ${outcome.scanned} file(s), ${
      outcome.status === "dry-run" ? "would rewrite" : "rewrote"
    } ${outcome.changed.length}.`,
  ];
  for (const file of outcome.changed.slice(0, 20)) {
    lines.push(`  ${file}`);
  }
  if (outcome.changed.length > 20) {
    lines.push(`  … and ${outcome.changed.length - 20} more`);
  }
  if (outcome.skipped.length > 0) {
    lines.push(`${outcome.skipped.length} file(s) could not be parsed:`);
    for (const entry of outcome.skipped) {
      lines.push(`  ${entry.path}: ${entry.error}`);
    }
  }
  if (outcome.backupPath !== undefined) {
    lines.push(`backup: ${outcome.backupPath}`);
  }
  return lines.join("\n");
}

const check = process.argv.includes("--check");
const repository = await MemoryNodeRepository.open();

try {
  const outcome = await runPendingMigrations(repository.store, undefined, {
    dryRun: check,
    force: true,
  });

  if (outcome === null) {
    console.log("nothing to do: this store has no pending migration.");
  } else {
    console.log(summarise(outcome));
    if (outcome.skipped.length > 0) {
      process.exitCode = 1;
    }
  }
} finally {
  repository.store.close?.();
}
