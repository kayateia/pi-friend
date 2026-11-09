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
import { parseMemoryNode } from "./schema.ts";
import type { MemoryStore } from "./store.ts";

/** Bookkeeping file recording which migrations this store has had. */
export const MIGRATIONS_FILENAME = "migrations.json";

/** Directory holding a copy of the store taken before a migration rewrote it. */
export const MIGRATIONS_BACKUP_DIRNAME = "backups";

/** Identifier of the `emotional_flavor` → `emotional_flavour` rename. */
export const FLAVOUR_MIGRATION_ID = "emotional-flavour-rename";

/** Legacy front-matter spelling, only ever read by the migration. */
const LEGACY_FLAVOUR_KEY = "emotional_flavor";
/** Current front-matter spelling. */
const CURRENT_FLAVOUR_KEY = "emotional_flavour";

/** Areas a migration rewrites: live memories, and the versions kept of them. */
const MIGRATED_DIRECTORIES = ["nodes", "staging", "history"] as const;

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

  const { scanned, skipped } = await scanStore(store, false);
  if (skipped.length > 0) {
    return {
      status: "already-applied",
      scanned,
      changed: [],
      skipped,
      backupPath,
    };
  }

  await rm(backupPath, { recursive: true, force: true });
  delete state.backups[FLAVOUR_MIGRATION_ID];
  await writeMigrationState(statePath, state);
  return { status: "retired-backup", scanned, changed: [], skipped: [], backupPath };
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

  for (const directory of MIGRATED_DIRECTORIES) {
    for (const relativePath of await listMarkdownFiles(store, directory)) {
      scanned += 1;
      let text: string;
      try {
        text = await store.readTextFile(relativePath);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      const rewritten = renameFlavourKey(text);
      if (rewritten === undefined) {
        continue;
      }

      try {
        parseMigratedFile(rewritten, relativePath, directory);
      } catch (error) {
        skipped.push({ path: relativePath, error: formatError(error) });
        continue;
      }

      if (collectRewrites) {
        pending.push({ path: relativePath, rewritten });
      }
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

  let changed = false;
  for (let position = 1; position < closing; position += 1) {
    const line = lines[position];
    if (line?.startsWith(`${LEGACY_FLAVOUR_KEY}:`)) {
      lines[position] = `${CURRENT_FLAVOUR_KEY}:${line.slice(
        LEGACY_FLAVOUR_KEY.length + 1,
      )}`;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : undefined;
}

/** Parses a rewritten file the way its area is normally parsed. */
function parseMigratedFile(
  text: string,
  relativePath: string,
  directory: (typeof MIGRATED_DIRECTORIES)[number],
): void {
  const slug = slugForPath(relativePath);
  if (directory === "history") {
    // History holds a node in whatever state it was in, including `candidate`,
    // so it is parsed without the live areas' status rules.
    parseMemoryNode(text, slug, undefined, { allowHistoryFields: true });
    return;
  }
  parseMemoryNode(text, slug);
}

/** Lists every Markdown file under one store directory, recursively. */
async function listMarkdownFiles(
  store: MemoryStore,
  directory: string,
): Promise<string[]> {
  const files = await store.listDirectoryMarkdown(directory);
  const nested = await store.listDirectories(directory);
  for (const child of nested) {
    files.push(...(await listMarkdownFiles(store, child)));
  }
  return files;
}

/**
 * Derives the slug a stored file belongs to.
 *
 * History versions are named after the moment they stopped being current, so the
 * slug comes from the directory above them; a deleted or dropped entry keeps the
 * slug as its file name.
 */
function slugForPath(relativePath: string): string {
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  const stem = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const versioned = segments.length >= 4 && segments[0] === "history";
  return versioned ? (segments.at(-2) ?? stem) : stem;
}

/** Reads the migration record, treating absence or damage as "nothing applied". */
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
