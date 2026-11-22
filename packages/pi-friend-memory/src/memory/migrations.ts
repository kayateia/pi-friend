/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logError } from "../debug/log.ts";
import {
  listStoredMemoryFiles,
  parseStoredMemoryFile,
  slugForStoredPath,
  STORED_MEMORY_DIRECTORIES,
  validateMemoryFiles,
} from "./validation.ts";
import { LEGACY_TOMBSTONE_PREFIX } from "./paths.ts";
import { serializeMemoryNode } from "./schema.ts";
import type { MemoryStore } from "./store.ts";

/** Bookkeeping file recording which migrations this store has had. */
export const MIGRATIONS_FILENAME = "migrations.json";

/** Directory holding a copy of the store taken before a migration rewrote it. */
export const MIGRATIONS_BACKUP_DIRNAME = "backups";

/** Identifier of the `emotional_flavor` → `emotional_flavour` rename. */
export const FLAVOUR_MIGRATION_ID = "emotional-flavour-rename";

/** Identifier of the pass that removes links naming no memory. */
export const DANGLING_LINKS_MIGRATION_ID = "dangling-links-removed";

/** Identifier of the pass that turns the single `source` into `sources`. */
export const SOURCE_FIELD_MIGRATION_ID = "source-field-to-sources";

/** Identifier of the pass that removes the superseded concept. */
export const SUPERSEDED_MIGRATION_ID = "superseded-fields-removed";

/**
 * Identifier of the pass that removes `edited` from staging candidates.
 *
 * A candidate is never edited, so the field dates nothing. It is not harmless
 * either: `edited ?? created` is the content timestamp a sync compares, so an
 * inherited value would let a draft claim to be newer than it is.
 */
export const STAGING_EDITED_MIGRATION_ID = "staging-edited-field";

/** Legacy front-matter spelling, only ever read by the migration. */
const LEGACY_FLAVOUR_KEY = "emotional_flavor";
/** Current front-matter spelling. */
const CURRENT_FLAVOUR_KEY = "emotional_flavour";

/** What the on-disk migration record holds. */
interface MigrationState {
  applied: string[];
  /** Backup directory per applied migration, until it has been retired. */
  backups: Record<string, string>;
}

/** One migration pass, whatever it decided to do. */
export interface MigrationOutcome {
  status: "applied" | "already-applied" | "retired-backup" | "dry-run";
  /** Files examined. */
  scanned: number;
  /** Relative paths rewritten. */
  changed: string[];
  /** Files that could not be parsed, and why; never touched. */
  skipped: Array<{ path: string; error: string }>;
  backupPath?: string;
}

/** Resolves the migration record's path, beside the capture cursors. */
export function migrationsPath(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, "pi-friend", "memory", MIGRATIONS_FILENAME);
}

/**
 * Applies any migration this store has not had yet.
 *
 * Called at the top of `session_start`, before anything parses a node, because
 * the alternative — a parser that accepts both spellings — would leave a legacy
 * key legal forever for the sake of one rename.
 *
 * The work is idempotent: a crash part-way leaves files unmigrated rather than
 * the record claiming otherwise, and the next start simply does it again.
 *
 * `force` ignores the record, which is what the script uses: a file that arrives
 * after the store was migrated — restored from an old snapshot, copied from
 * another instance — is refused by name at parse time and converted by hand.
 */
export async function runPendingMigrations(
  store: MemoryStore,
  agentDir: string = getAgentDir(),
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<MigrationOutcome | null> {
  const statePath = migrationsPath(agentDir);
  const state = await readMigrationState(statePath);

  if (state.applied.includes(FLAVOUR_MIGRATION_ID) && options.force !== true) {
    return retireFlavourBackupIfClean(store, agentDir, statePath, state);
  }

  if (options.dryRun === true) {
    const scan = await scanStore(store, true);
    return {
      status: "dry-run",
      scanned: scan.scanned,
      changed: scan.pending.map((file) => file.path),
      skipped: scan.skipped,
    };
  }

  return migrateFlavourSpelling(store, agentDir, statePath);
}

/**
 * Deletes the pre-migration copy once the store has proved it survived.
 *
 * The backup exists for a migration that went wrong in a way nobody noticed at
 * the time, so it is kept for exactly one clean start after the rewrite: the
 * store parses, every file carries the new key, and only then is the copy
 * removed. A backup nobody ever deletes is a second, stale copy of the memory.
 */
async function retireFlavourBackupIfClean(
  store: MemoryStore,
  agentDir: string,
  statePath: string,
  state: MigrationState,
): Promise<MigrationOutcome | null> {
  const backupPath = state.backups[FLAVOUR_MIGRATION_ID];
  if (backupPath === undefined) {
    return null;
  }

  const report = await validateMemoryFiles(store);
  if (report.failures.length > 0) {
    return {
      status: "already-applied",
      scanned: report.scanned,
      changed: [],
      skipped: report.failures,
      backupPath,
    };
  }

  await rm(backupPath, { recursive: true, force: true });
  delete state.backups[FLAVOUR_MIGRATION_ID];
  await writeMigrationState(statePath, state);
  return {
    status: "retired-backup",
    scanned: report.scanned,
    changed: [],
    skipped: [],
    backupPath,
  };
}

/** Rewrites the legacy flavour spelling across the store, once. */
async function migrateFlavourSpelling(
  store: MemoryStore,
  agentDir: string,
  statePath: string,
): Promise<MigrationOutcome> {
  const scan = await scanStore(store, true);
  const backupPath = path.join(
    agentDir,
    "pi-friend",
    "memory",
    MIGRATIONS_BACKUP_DIRNAME,
    FLAVOUR_MIGRATION_ID,
  );

  // Copy every file that is about to change, before changing any of them. Only
  // these are at risk, and a precise copy restores by putting files back where
  // they were — which a whole-store snapshot would also do, at more size and
  // with the hazard of copying the store into a directory inside itself.
  for (const file of scan.pending) {
    const target = path.join(backupPath, "files", file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(store.root, file.path), target);
  }

  const changed: string[] = [];
  for (const file of scan.pending) {
    await store.writeTextFile(file.path, file.rewritten);
    changed.push(file.path);
  }

  const state = await readMigrationState(statePath);
  state.applied = [...new Set([...state.applied, FLAVOUR_MIGRATION_ID])];
  state.backups[FLAVOUR_MIGRATION_ID] = backupPath;
  await writeMigrationState(statePath, state);

  return {
    status: "applied",
    scanned: scan.scanned,
    changed,
    skipped: scan.skipped,
    backupPath,
  };
}

/** One file the migration will rewrite, with its new text already produced. */
interface PendingRewrite {
  path: string;
  rewritten: string;
}

/** Result of walking the store once. */
interface StoreScan {
  scanned: number;
  pending: PendingRewrite[];
  skipped: Array<{ path: string; error: string }>;
}

/**
 * Walks the migrated areas, collecting files that need the new key.
 *
 * The rewrite is a line replacement inside the front matter, not a parse and
 * re-serialise: a rename should change one line and leave every other byte of a
 * memory as it was, including the history entries whose value is being a faithful
 * copy of something. The result is then parsed with the strict parser, and only
 * kept if it parses — so a file that was already damaged is reported instead of
 * being rewritten into something that merely looks damaged differently.
 */
async function scanStore(
  store: MemoryStore,
  collectRewrites: boolean,
): Promise<StoreScan> {
  let scanned = 0;
  const pending: PendingRewrite[] = [];
  const skipped: Array<{ path: string; error: string }> = [];

  for (const directory of STORED_MEMORY_DIRECTORIES) {
    for (const relativePath of await listStoredMemoryFiles(store, directory)) {
      scanned += 1;
      let text: string;
      try {
        text = await store.readTextFile(relativePath);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      if (!collectRewrites) {
        // Verification pass: every file has to parse, not only the ones that
        // still have something to rename. Skipping the rest would make this
        // check vacuous, which is how it was written the first time.
        try {
          parseStoredMemoryFile(text, relativePath, directory);
        } catch (error) {
          skipped.push({ path: relativePath, error: formatError(error) });
        }
        continue;
      }

      const rewritten = renameFlavourKey(text);
      if (rewritten === undefined) {
        continue;
      }

      try {
        parseStoredMemoryFile(rewritten, relativePath, directory);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      pending.push({ path: relativePath, rewritten });
    }
  }

  return { scanned, pending, skipped };
}

/**
 * Replaces the legacy key where it sits, leaving every other byte alone.
 *
 * Only an unindented key inside the opening front-matter block is touched, so a
 * body line that happens to contain the word is never rewritten.
 */
export function renameFlavourKey(text: string): string | undefined {
  return rewriteFrontMatterLines(text, (line) =>
    line.startsWith(`${LEGACY_FLAVOUR_KEY}:`)
      ? `${CURRENT_FLAVOUR_KEY}:${line.slice(LEGACY_FLAVOUR_KEY.length + 1)}`
      : undefined,
  );
}

/**
 * Rewrites lines inside the opening front-matter block.
 *
 * `rewrite` returns a replacement line, `null` to delete the line, or
 * `undefined` to leave it alone. Everything outside the block — the body above
 * all — is never handed to it.
 */
function rewriteFrontMatterLines(
  text: string,
  rewrite: (line: string) => string | null | undefined,
): string | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const closing = lines.findIndex(
    (line, position) => position > 0 && line.trim() === "---",
  );
  if (closing < 0) {
    return undefined;
  }

  const head = lines.slice(0, closing);
  const kept: string[] = [];
  let changed = false;
  for (const line of head) {
    const next = rewrite(line);
    if (next === null) {
      changed = true;
      continue;
    }
    if (next !== undefined) {
      changed = true;
      kept.push(next);
      continue;
    }
    kept.push(line);
  }
  return changed ? [...kept, ...lines.slice(closing)].join("\n") : undefined;
}

/**
 * Removes `edited` from staging candidates written before it was refused.
 *
 * Called before the rename migration, because the strict parser refuses a
 * staging file carrying the field and would otherwise report that file as
 * unparseable rather than migrating it.
 *
 * There is no backup and no retirement step, unlike the rename: nothing in the
 * file's content changes, the line being removed is a timestamp that described
 * an operation this area never has, and every rewritten file is parsed before
 * it is written. A copy would preserve a second stale record of the store for
 * the sake of one meaningless key.
 */
export async function stripCandidateEditedFields(
  store: MemoryStore,
  agentDir: string = getAgentDir(),
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<MigrationOutcome | null> {
  const statePath = migrationsPath(agentDir);
  const state = await readMigrationState(statePath);
  if (
    state.applied.includes(STAGING_EDITED_MIGRATION_ID) &&
    options.force !== true
  ) {
    return null;
  }

  const scan = await scanStagingForEditedField(store);
  if (options.dryRun === true) {
    return {
      status: "dry-run",
      scanned: scan.scanned,
      changed: scan.pending.map((file) => file.path),
      skipped: scan.skipped,
    };
  }

  for (const file of scan.pending) {
    await store.writeTextFile(file.path, file.rewritten);
  }

  // Re-read rather than reuse: another migration may have recorded itself
  // between these two points, and this write must not drop it.
  const fresh = await readMigrationState(statePath);
  fresh.applied = [...new Set([...fresh.applied, STAGING_EDITED_MIGRATION_ID])];
  await writeMigrationState(statePath, fresh);

  return {
    status: "applied",
    scanned: scan.scanned,
    changed: scan.pending.map((file) => file.path),
    skipped: scan.skipped,
  };
}

/** Walks `staging/` for files that still carry an `edited` key. */
async function scanStagingForEditedField(store: MemoryStore): Promise<StoreScan> {
  let scanned = 0;
  const pending: PendingRewrite[] = [];
  const skipped: Array<{ path: string; error: string }> = [];

  for (const relativePath of await listStoredMemoryFiles(store, "staging")) {
    scanned += 1;
    let text: string;
    try {
      text = await store.readTextFile(relativePath);
    } catch (error) {
      skipped.push({ path: relativePath, error: formatError(error) });
      continue;
    }

    const rewritten = removeEditedKey(text);
    if (rewritten === undefined) {
      continue;
    }
    // Only keep the rewrite if the result is a candidate the strict parser
    // accepts. A file that was already damaged is reported, never rewritten
    // into something that merely looks damaged differently.
    try {
      parseStoredMemoryFile(rewritten, relativePath, "staging");
    } catch (error) {
      skipped.push({ path: relativePath, error: formatError(error) });
      continue;
    }
    pending.push({ path: relativePath, rewritten });
  }

  return { scanned, pending, skipped };
}

/**
 * Drops a top-level `edited:` line from the opening front-matter block.
 *
 * Only an unindented key is removed, so a body line — or an indented key that
 * happens to share the name — is never touched.
 */
export function removeEditedKey(text: string): string | undefined {
  return rewriteFrontMatterLines(text, (line) =>
    line.startsWith("edited:") ? null : undefined,
  );
}

/**
 * Removes `supersedes` and `superseded_by` from stored node files.
 *
 * Both keys described a relationship the schema no longer has: the history tree
 * records what replaced what, and nothing ever wrote a non-empty value. Every
 * stored file still carries the two lines, because they were part of the
 * required front matter — so removing them from the schema makes the strict
 * parser refuse the entire store until this pass has run.
 *
 * A line-level rewrite, not a parse and re-serialise: a history entry's value is
 * that it is a faithful copy of what existed, and only these two keys change.
 * The result is parsed before it is written, and a file that was already damaged
 * is reported and left alone rather than rewritten into something that looks
 * damaged differently.
 *
 * Files under the legacy tombstone directory are moved into `history/deleted/`
 * with the two fields they carried reset, which is what the old tombstone meant:
 * a deleted node, restored to the state it had before deletion.
 */
export async function stripSupersededFields(
  store: MemoryStore,
  agentDir: string = getAgentDir(),
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<MigrationOutcome | null> {
  const statePath = migrationsPath(agentDir);
  const state = await readMigrationState(statePath);
  if (
    state.applied.includes(SUPERSEDED_MIGRATION_ID) &&
    options.force !== true
  ) {
    return null;
  }

  const scan = await scanSupersededFields(store);
  if (options.dryRun === true) {
    return {
      status: "dry-run",
      scanned: scan.scanned,
      changed: scan.pending.map((file) => file.path),
      skipped: scan.skipped,
    };
  }

  for (const file of scan.pending) {
    if (file.destination !== undefined) {
      await store.writeTextFile(file.destination, file.rewritten);
      await store.removeTextFile(file.path);
      continue;
    }
    await store.writeTextFile(file.path, file.rewritten);
  }
  await store.removeDirectoryIfEmpty("nodes/superseded");

  const fresh = await readMigrationState(statePath);
  fresh.applied = [...new Set([...fresh.applied, SUPERSEDED_MIGRATION_ID])];
  await writeMigrationState(statePath, fresh);

  return {
    status: "applied",
    scanned: scan.scanned,
    changed: scan.pending.map(
      (file) => file.destination ?? file.path,
    ),
    skipped: scan.skipped,
  };
}

/** One file the superseded migration will rewrite, and where it lands. */
interface SupersededRewrite {
  path: string;
  rewritten: string;
  /** Set for a legacy tombstone, which leaves its directory for `history/`. */
  destination?: string;
}

/** Walks every stored area for files carrying the retired keys. */
async function scanSupersededFields(
  store: MemoryStore,
): Promise<{
  scanned: number;
  pending: SupersededRewrite[];
  skipped: Array<{ path: string; error: string }>;
}> {
  let scanned = 0;
  const pending: SupersededRewrite[] = [];
  const skipped: Array<{ path: string; error: string }> = [];

  for (const directory of STORED_MEMORY_DIRECTORIES) {
    for (const relativePath of await listStoredMemoryFiles(store, directory)) {
      scanned += 1;
      const normalized = relativePath.split(path.sep).join("/");
      const tombstone = normalized.startsWith(LEGACY_TOMBSTONE_PREFIX);
      let text: string;
      try {
        text = await store.readTextFile(relativePath);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      const rewritten = migrateSupersededFrontMatter(text, tombstone);
      if (rewritten === undefined) {
        continue;
      }

      const destination = tombstone
        ? `history/deleted/${path.posix.basename(normalized)}`
        : undefined;
      // A tombstone archived before must not overwrite the copy already kept:
      // the first conversion is the one a person restored from.
      if (
        destination !== undefined &&
        (await store.readTextFileIfExists(destination)) !== null
      ) {
        skipped.push({
          path: relativePath,
          error: `${destination} already exists; the tombstone was left in place.`,
        });
        continue;
      }
      try {
        parseStoredMemoryFile(
          rewritten,
          destination ?? relativePath,
          destination === undefined ? directory : "history",
        );
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }
      pending.push({
        path: relativePath,
        rewritten,
        ...(destination === undefined ? {} : { destination }),
      });
    }
  }

  return { scanned, pending, skipped };
}

/**
 * Removes the retired keys from one file's opening front-matter block.
 *
 * A block-style `supersedes:` list is removed with its items; an indented line
 * that is not a list item is left alone, because it belongs to whatever key
 * precedes it and not to this one. `status: superseded` and a zero decay weight
 * are rewritten only when converting a legacy tombstone, where they described a
 * deleted node rather than a live one.
 */
export function migrateSupersededFrontMatter(
  text: string,
  tombstone = false,
): string | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const closing = lines.findIndex(
    (line, position) => position > 0 && line.trim() === "---",
  );
  if (closing < 0) {
    return undefined;
  }

  const head = lines.slice(0, closing);
  const kept: string[] = [];
  let changed = false;
  for (let index = 0; index < head.length; index += 1) {
    const line = head[index]!;
    if (line.startsWith("superseded_by:")) {
      changed = true;
      continue;
    }
    if (line.startsWith("supersedes:")) {
      changed = true;
      if (line.slice("supersedes:".length).trim() === "") {
        let next = index + 1;
        while (next < head.length && /^\s+-\s?/.test(head[next]!)) {
          next += 1;
        }
        index = next - 1;
      }
      continue;
    }
    if (tombstone && /^status:\s*superseded\s*$/.test(line)) {
      changed = true;
      kept.push("status: active");
      continue;
    }
    if (tombstone && /^decay_weight:\s*0(?:\.0+)?\s*$/.test(line)) {
      changed = true;
      kept.push("decay_weight: 1");
      continue;
    }
    kept.push(line);
  }

  return changed ? [...kept, ...lines.slice(closing)].join("\n") : undefined;
}

/**
 * Removes links that name no canonical memory.
 *
 * Links had no check until one existed, so a store that predates it carries
 * pointers at memories that were merged away or deleted years ago. Nothing can
 * retarget them — a merged node's history entry does not record where its
 * content went — and nothing can follow them, so the only honest repair is to
 * take them out.
 *
 * Live areas only. A history entry is a snapshot of a node as it was, and the
 * memories it pointed at then may legitimately be gone; editing one would make
 * it a record of something that did not happen.
 *
 * This is the one migration that re-serialises rather than rewriting lines:
 * removing an item from a YAML list is a structural edit, and every file here
 * was written by the same serialiser, so the result differs only in its links.
 */
export async function pruneDanglingLinks(
  store: MemoryStore,
  agentDir: string = getAgentDir(),
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<MigrationOutcome | null> {
  const statePath = migrationsPath(agentDir);
  const state = await readMigrationState(statePath);
  if (
    state.applied.includes(DANGLING_LINKS_MIGRATION_ID) &&
    options.force !== true
  ) {
    return null;
  }

  const scan = await scanDanglingLinks(store);
  if (options.dryRun === true) {
    return {
      status: "dry-run",
      scanned: scan.scanned,
      changed: scan.pending.map((file) => file.path),
      skipped: scan.skipped,
    };
  }

  for (const file of scan.pending) {
    await store.writeTextFile(file.path, file.rewritten);
  }

  const fresh = await readMigrationState(statePath);
  fresh.applied = [...new Set([...fresh.applied, DANGLING_LINKS_MIGRATION_ID])];
  await writeMigrationState(statePath, fresh);

  return {
    status: "applied",
    scanned: scan.scanned,
    changed: scan.pending.map((file) => file.path),
    skipped: scan.skipped,
  };
}

/** Walks the live areas for links that resolve to nothing. */
async function scanDanglingLinks(store: MemoryStore): Promise<StoreScan> {
  let scanned = 0;
  const pending: PendingRewrite[] = [];
  const skipped: Array<{ path: string; error: string }> = [];

  const canonical = new Set<string>();
  for (const relativePath of await listStoredMemoryFiles(store, "nodes")) {
    canonical.add(slugForStoredPath(relativePath));
  }

  for (const directory of ["nodes", "staging"] as const) {
    for (const relativePath of await listStoredMemoryFiles(store, directory)) {
      scanned += 1;
      let text: string;
      try {
        text = await store.readTextFile(relativePath);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      let node;
      try {
        node = parseStoredMemoryFile(text, relativePath, directory);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      const links = node.frontMatter.links.filter(
        (link) => link !== node.slug && canonical.has(link),
      );
      if (links.length === node.frontMatter.links.length) {
        continue;
      }

      node.frontMatter.links = links;
      const rewritten = serializeMemoryNode(node);
      try {
        parseStoredMemoryFile(rewritten, relativePath, directory);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }
      pending.push({ path: relativePath, rewritten });
    }
  }

  return { scanned, pending, skipped };
}

/**
 * Converts the retired free-text `source` into the `sources` array.
 *
 * The old field held one string and the new one holds records, so the mapping
 * is lossy by construction: a `session:<id>` becomes the session, a
 * `sweep:<id>` a sweep run, and anything else is kept verbatim under `other`
 * rather than dropped. A migration that exists to preserve provenance must not
 * be the operation that throws it away, even when all it can preserve is a
 * sentence.
 */
export async function convertSourceField(
  store: MemoryStore,
  agentDir: string = getAgentDir(),
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<MigrationOutcome | null> {
  const statePath = migrationsPath(agentDir);
  const state = await readMigrationState(statePath);
  if (
    state.applied.includes(SOURCE_FIELD_MIGRATION_ID) &&
    options.force !== true
  ) {
    return null;
  }

  const scan = await scanSourceField(store);
  if (options.dryRun === true) {
    return {
      status: "dry-run",
      scanned: scan.scanned,
      changed: scan.pending.map((file) => file.path),
      skipped: scan.skipped,
    };
  }

  for (const file of scan.pending) {
    await store.writeTextFile(file.path, file.rewritten);
  }

  const fresh = await readMigrationState(statePath);
  fresh.applied = [...new Set([...fresh.applied, SOURCE_FIELD_MIGRATION_ID])];
  await writeMigrationState(statePath, fresh);

  return {
    status: "applied",
    scanned: scan.scanned,
    changed: scan.pending.map((file) => file.path),
    skipped: scan.skipped,
  };
}

/** Walks every stored area for files that still carry `source`. */
async function scanSourceField(store: MemoryStore): Promise<StoreScan> {
  let scanned = 0;
  const pending: PendingRewrite[] = [];
  const skipped: Array<{ path: string; error: string }> = [];

  for (const directory of STORED_MEMORY_DIRECTORIES) {
    for (const relativePath of await listStoredMemoryFiles(store, directory)) {
      scanned += 1;
      let text: string;
      try {
        text = await store.readTextFile(relativePath);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      const rewritten = convertSourceFrontMatter(text);
      if (rewritten === undefined) {
        continue;
      }
      try {
        parseStoredMemoryFile(rewritten, relativePath, directory);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }
      pending.push({ path: relativePath, rewritten });
    }
  }

  return { scanned, pending, skipped };
}

/**
 * Replaces the `source:` line in one file's opening front matter.
 *
 * Only an unindented key is touched, so a body line is never rewritten. The
 * emitted block is plain YAML with JSON-quoted scalars, which keeps a value
 * containing a colon, a quote or a leading dash from changing the structure.
 */
export function convertSourceFrontMatter(text: string): string | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const closing = lines.findIndex(
    (line, position) => position > 0 && line.trim() === "---",
  );
  if (closing < 0) {
    return undefined;
  }

  const head = lines.slice(0, closing);
  const index = head.findIndex((line) => line.startsWith("source:"));
  const line = index < 0 ? undefined : head[index];
  if (index < 0 || line === undefined) {
    return undefined;
  }

  const value = unquoteYamlScalar(line.slice("source:".length).trim());
  const next = [...head.slice(0, index), ...sourceLines(value), ...head.slice(index + 1)];
  return [...next, ...lines.slice(closing)].join("\n");
}

/** The YAML block for one legacy value, or an empty array. */
function sourceLines(value: string): string[] {
  if (value === "") {
    return ["sources: []"];
  }
  const session = /^session:(.+)$/u.exec(value);
  const sweep = /^sweep:(.+)$/u.exec(value);
  const record =
    session !== null
      ? { action: "add", sessionId: session[1]!.trim() }
      : sweep !== null
        ? { action: "add", sweepRunId: sweep[1]!.trim() }
        : { action: "add", other: value };

  return [
    "sources:",
    `  - action: ${JSON.stringify(record.action)}`,
    ...Object.entries(record)
      .filter(([key]) => key !== "action")
      .map(([key, entry]) => `    ${key}: ${JSON.stringify(entry)}`),
  ];
}

/** Strips matching single or double quotes from a YAML scalar. */
function unquoteYamlScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function readMigrationState(statePath: string): Promise<MigrationState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as MigrationState).applied)
    ) {
      const record = parsed as MigrationState;
      return {
        applied: record.applied.filter(
          (id): id is string => typeof id === "string",
        ),
        backups:
          typeof record.backups === "object" && record.backups !== null
            ? record.backups
            : {},
      };
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      // A record we cannot read is not a reason to skip the work; the pass is
      // idempotent, so re-running it is harmless.
      logError("migration state", error);
    }
  }
  return { applied: [], backups: {} };
}

/** Writes the migration record atomically enough for a bookkeeping file. */
async function writeMigrationState(
  statePath: string,
  state: MigrationState,
): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Returns a short message for a failure, without a stack. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns a Node error code, or undefined for a non-Node failure. */
function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}
