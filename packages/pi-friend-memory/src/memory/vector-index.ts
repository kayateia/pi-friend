/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { logError } from "../debug/log.ts";
import type { MemoryFileKind } from "./paths.ts";
import type {
  MemoryStatus,
  MemoryType,
} from "./schema.ts";

/** Metadata identifying the embedding space stored in one index. */
export interface VectorIndexMetadata {
  model: string;
  dimensions: number;
  schemaVersion?: number;
}

/** One searchable vector and its canonical-source metadata. */
export interface VectorRecord {
  key: string;
  kind: MemoryFileKind;
  sourcePath: string;
  contentHash: string;
  embedding: Float32Array;
  title?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  decayWeight?: number;
  /**
   * When the underlying content last changed, as an ISO timestamp.
   *
   * A memory uses `edited ?? created`; an imported document uses the file's
   * modification time. Absent when neither is known.
   */
  modifiedAt?: string;
  tags?: string[];
}

/** Everything stored beside a vector except the vector itself. */
export type VectorRecordMetadata = Omit<VectorRecord, "embedding">;

/** Stored metadata for one indexed vector. */
export interface VectorEntryMetadata {
  key: string;
  kind: MemoryFileKind;
  sourcePath: string;
  contentHash: string;
  title?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  decayWeight?: number;
  modifiedAt?: string;
  tags: string[];
}

/**
 * Restrictions on which entries a nearest-neighbour search may return.
 *
 * They are applied inside the vector query, not to its results. A filter
 * applied afterwards judges a sample chosen without it: if the nearest `k` all
 * sit outside the requested window, the search returns nothing while matches
 * exist inside it. Each field is optional and they combine with AND.
 */
export interface VectorSearchFilters {
  kinds?: readonly MemoryFileKind[];
  type?: MemoryType;
  status?: MemoryStatus;
  /** Inclusive lower bound on `modifiedAt`, as an ISO timestamp. */
  since?: string;
  /** Inclusive upper bound on `modifiedAt`, as an ISO timestamp. */
  until?: string;
}

/** One nearest-neighbor result. */
export interface VectorSearchHit extends VectorEntryMetadata {
  distance: number;
}

/** Options for opening or creating a SQLite vector index. */
export interface SqliteVectorIndexOptions extends VectorIndexMetadata {
  databasePath: string;
}

/** Backend-neutral operations required by the memory retrieval layer. */
export interface VectorIndex {
  readonly metadata: Required<VectorIndexMetadata>;
  upsert(record: VectorRecord): void;
  remove(key: string): boolean;
  /**
   * Stores metadata for an entry that already has a vector.
   *
   * Used when what changed is a description of the content rather than the
   * content: a decay weight, a status, a timestamp. The embedding is untouched,
   * so no provider call is needed.
   */
  updateMetadata(record: VectorRecordMetadata): void;
  search(
    embedding: Float32Array,
    limit?: number,
    filters?: VectorSearchFilters,
  ): VectorSearchHit[];
  listEntries(): VectorEntryMetadata[];
  count(): number;
  clear(): void;
  rebuild(records: VectorRecord[]): void;
  close(): void;
}

/** Error raised when the vector index cannot preserve its metadata contract. */
export class VectorIndexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VectorIndexError";
  }
}

const CURRENT_SCHEMA_VERSION = 2;
const MAX_DIMENSIONS = 8_192;
const DEFAULT_SEARCH_LIMIT = 5;

/**
 * Relational tables, created when absent.
 *
 * `modified_at` arrived with schema version 2. Because a version mismatch
 * discards the index rather than migrating it, an existing table is never
 * altered here: it is dropped with the file it lives in.
 */
/**
 * Tables that identify and describe the index, created when absent.
 *
 * Only statements that are safe against any older layout belong here: they run
 * before the recorded version is known, because the version lives in one of
 * them. Anything that depends on a column a previous version lacked is in
 * {@link CURRENT_SCHEMA_SQL} and runs after the version has been checked.
 */
const CORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS vector_index_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vector_entries (
    rowid INTEGER PRIMARY KEY,
    entry_key TEXT NOT NULL UNIQUE,
    entry_kind TEXT NOT NULL,
    source_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    title TEXT,
    memory_type TEXT,
    memory_status TEXT,
    decay_weight REAL,
    modified_at TEXT,
    tags_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Statements that assume the current layout, run only once it is confirmed.
 *
 * `modified_at` arrived with schema version 2. Creating its index against a
 * version 1 table fails with "no such column", which would abort the open
 * before the mismatch could be noticed and the index regenerated.
 */
const CURRENT_SCHEMA_SQL = `
  CREATE INDEX IF NOT EXISTS vector_entries_modified_at
    ON vector_entries(modified_at);
`;

/**
 * Disposable sqlite-vec index.
 *
 * Canonical Markdown remains outside this class. Every operation here may be
 * reproduced by rebuilding from indexed records.
 */
export class SqliteVectorIndex implements VectorIndex {
  readonly metadata: Required<VectorIndexMetadata>;
  readonly databasePath: string;
  /**
   * True when an existing index was discarded on open because its schema or
   * embedding space no longer matched, so its contents are being rebuilt.
   *
   * Exposed so the caller can say so once, rather than leaving the cost of a
   * rebuild to be inferred from a sudden burst of embedding requests.
   */
  readonly rebuilt: boolean;
  private readonly database: DatabaseSync;

  /** Opens an existing index or creates one for the supplied embedding space. */
  static open(options: SqliteVectorIndexOptions): SqliteVectorIndex {
    return new SqliteVectorIndex(options);
  }

  private constructor(options: SqliteVectorIndexOptions) {
    const metadata = validateMetadata(options);
    this.metadata = metadata;
    this.databasePath = options.databasePath;

    if (options.databasePath !== ":memory:") {
      mkdirSync(path.dirname(options.databasePath), {
        recursive: true,
        mode: 0o700,
      });
    }

    const opened = openIndex(metadata, options.databasePath);
    this.database = opened.database;
    this.rebuilt = opened.rebuilt;
    if (options.databasePath !== ":memory:") {
      chmodSync(options.databasePath, 0o600);
    }
  }

  /** Inserts or replaces one vector record transactionally. */
  upsert(record: VectorRecord): void {
    validateRecord(record, this.metadata.dimensions);
    this.transaction(() => this.upsertWithoutTransaction(record));
  }

  /** Updates the metadata of an entry whose vector is already stored. */
  updateMetadata(record: VectorRecordMetadata): void {
    requireNonEmptyString(record.key, "key");
    this.transaction(() => {
      if (this.selectRowid(record.key) === null) {
        throw new VectorIndexError(
          `Cannot update metadata for unindexed entry ${record.key}.`,
        );
      }
      this.writeMetadata(record);
    });
  }

  /** Removes one record, returning false when the key was absent. */
  remove(key: string): boolean {
    requireNonEmptyString(key, "key");
    return this.transaction(() => {
      const rowid = this.selectRowid(key);
      if (rowid === null) {
        return false;
      }

      this.database
        .prepare("DELETE FROM vector_embeddings WHERE rowid = ?")
        .run(rowid);
      this.database
        .prepare("DELETE FROM vector_entries WHERE rowid = ?")
        .run(rowid);
      return true;
    });
  }

  /**
   * Searches nearest vectors using cosine distance.
   *
   * Filters restrict the search itself, not its results: they are evaluated as
   * a rowid set inside the nearest-neighbour query, so a narrow window still
   * returns its own nearest entries rather than nothing.
   */
  search(
    embedding: Float32Array,
    limit = DEFAULT_SEARCH_LIMIT,
    filters: VectorSearchFilters = {},
  ): VectorSearchHit[] {
    validateEmbedding(embedding, this.metadata.dimensions);
    const safeLimit = clampLimit(limit);
    const { sql: filterSql, params: filterParams } = buildFilterClause(filters);
    const rows = this.database
      .prepare(
        `
          SELECT
            entries.entry_key,
            entries.entry_kind,
            entries.source_path,
            entries.content_hash,
            entries.title,
            entries.memory_type,
            entries.memory_status,
            entries.decay_weight,
            entries.modified_at,
            entries.tags_json,
            nearest.distance
          FROM (
            SELECT rowid, distance
            FROM vector_embeddings
            WHERE embedding MATCH ? AND k = ?${filterSql}
            ORDER BY distance
          ) AS nearest
          JOIN vector_entries AS entries ON entries.rowid = nearest.rowid
          ORDER BY nearest.distance
        `,
      )
      .all(embedding, safeLimit, ...filterParams);

    return rows.map((row) => ({
      ...parseEntryMetadata(row),
      distance: requireNumber(row.distance, "distance"),
    }));
  }

  /** Lists metadata for every indexed vector without loading embeddings. */
  listEntries(): VectorEntryMetadata[] {
    return this.database
      .prepare(
        `
          SELECT
            entry_key,
            entry_kind,
            source_path,
            content_hash,
            title,
            memory_type,
            memory_status,
            decay_weight,
            modified_at,
            tags_json
          FROM vector_entries
          ORDER BY entry_key
        `,
      )
      .all()
      .map(parseEntryMetadata);
  }

  /** Number of records currently stored in the index. */
  count(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM vector_entries")
      .get();
    return requireNumber(row?.count, "count");
  }

  /** Removes every record while preserving the configured embedding space. */
  clear(): void {
    this.transaction(() => this.clearWithoutTransaction());
  }

  /** Atomically clears and repopulates the index. */
  rebuild(records: VectorRecord[]): void {
    for (const record of records) {
      validateRecord(record, this.metadata.dimensions);
    }

    this.transaction(() => {
      this.clearWithoutTransaction();
      for (const record of records) {
        this.upsertWithoutTransaction(record);
      }
    });
  }

  /** Releases the SQLite connection. */
  close(): void {
    this.database.close();
  }

  /** Creates the metadata, relational, and vec0 tables when absent. */
  /** Runs one callback inside an immediate SQLite transaction. */
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch (rollbackError) {
        // Preserve the original operation error while recording rollback failure.
        logError("vector index rollback", rollbackError);
      }
      throw error;
    }
  }

  /** Performs an upsert while the caller owns the transaction. */
  private upsertWithoutTransaction(record: VectorRecord): void {
    this.writeMetadata(record);

    const rowid = this.selectRowid(record.key);
    if (rowid === null) {
      throw new VectorIndexError(`Vector metadata row missing for ${record.key}.`);
    }

    this.database
      .prepare("DELETE FROM vector_embeddings WHERE rowid = ?")
      .run(rowid);
    this.database
      .prepare(
        "INSERT INTO vector_embeddings(rowid, embedding) VALUES (?, ?)",
      )
      .run(rowid, record.embedding);
  }

  /**
   * Writes the relational row for one entry, leaving the vector alone.
   *
   * The caller must own a transaction.
   */
  private writeMetadata(record: VectorRecordMetadata): void {
    this.database
      .prepare(
        `
          INSERT INTO vector_entries(
            entry_key,
            entry_kind,
            source_path,
            content_hash,
            title,
            memory_type,
            memory_status,
            decay_weight,
            modified_at,
            tags_json,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_key) DO UPDATE SET
            entry_kind = excluded.entry_kind,
            source_path = excluded.source_path,
            content_hash = excluded.content_hash,
            title = excluded.title,
            memory_type = excluded.memory_type,
            memory_status = excluded.memory_status,
            decay_weight = excluded.decay_weight,
            modified_at = excluded.modified_at,
            tags_json = excluded.tags_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        record.key,
        record.kind,
        record.sourcePath,
        record.contentHash,
        record.title ?? null,
        record.type ?? null,
        record.status ?? null,
        record.decayWeight ?? null,
        record.modifiedAt ?? null,
        JSON.stringify(record.tags ?? []),
        new Date().toISOString(),
      );
  }

  /** Clears both relational and vector tables while inside a transaction. */
  private clearWithoutTransaction(): void {
    this.database.exec(`
      DELETE FROM vector_embeddings;
      DELETE FROM vector_entries;
    `);
  }

  /** Returns the integer rowid associated with a key. */
  private selectRowid(key: string): bigint | null {
    const row = this.database
      .prepare("SELECT rowid FROM vector_entries WHERE entry_key = ?")
      .get(key);
    return row === undefined ? null : requireBigInt(row.rowid, "rowid");
  }
}

/**
 * Opens the index, discarding one written under a different schema or space.
 *
 * The index is derived data: every vector in it can be recomputed from the
 * Markdown and the embedding provider. So a schema revision, or a change of
 * embedding model or width, deletes the file and starts again rather than
 * migrating a table whose contents are about to be rewritten anyway. The
 * alternative — refusing to open — leaves semantic search disabled until a
 * person deletes the file by hand.
 *
 * The returned `rebuilt` flag is true when that happened, so the caller can say
 * so once instead of letting a burst of embedding requests go unexplained.
 */
function openIndex(
  metadata: Required<VectorIndexMetadata>,
  databasePath: string,
): { database: DatabaseSync; rebuilt: boolean } {
  try {
    const first = openDatabase(metadata, databasePath);
    if (first.stored !== null && !sameSpace(first.stored, metadata)) {
      first.database.close();
      removeDatabaseFiles(databasePath);
      const fresh = openDatabase(metadata, databasePath);
      applyCurrentSchema(fresh.database, metadata);
      return { database: fresh.database, rebuilt: true };
    }

    applyCurrentSchema(first.database, metadata);
    return { database: first.database, rebuilt: false };
  } catch (error) {
    throw new VectorIndexError(
      `Could not initialize sqlite-vec index at ${databasePath}.`,
      { cause: error },
    );
  }
}

/**
 * Adds what the current layout assumes, once that layout is confirmed.
 *
 * Deliberately after the version check: an index a version behind does not have
 * the column, and creating an index over it fails before anything can notice
 * the version, which is the state that has to be recovered from rather than
 * reported as a startup error.
 */
function applyCurrentSchema(
  database: DatabaseSync,
  metadata: Required<VectorIndexMetadata>,
): void {
  database.exec(CURRENT_SCHEMA_SQL);
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vector_embeddings USING vec0(
      embedding float[${metadata.dimensions}] distance_metric=cosine
    );
  `);
}

/** One open connection, plus whatever schema it already carried. */
function openDatabase(
  metadata: Required<VectorIndexMetadata>,
  databasePath: string,
): { database: DatabaseSync; stored: StoredMetadata | null } {
  const database = new DatabaseSync(databasePath, {
    allowExtension: true,
    timeout: 5_000,
  });

  try {
    sqliteVec.load(database);
    database.enableLoadExtension(false);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(CORE_SCHEMA_SQL);

    const stored = readStoredMetadata(database);
    if (stored === null) {
      database
        .prepare(
          "INSERT INTO vector_index_meta(id, schema_version, model, dimensions) VALUES (1, ?, ?, ?)",
        )
        .run(
          metadata.schemaVersion,
          metadata.model,
          metadata.dimensions,
        );
    }

    return { database, stored };
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Schema identity recorded in the index itself. */
interface StoredMetadata {
  schemaVersion: number;
  model: string;
  dimensions: number;
}

/** Reads the recorded schema identity, or null for a new index. */
function readStoredMetadata(database: DatabaseSync): StoredMetadata | null {
  const row = database
    .prepare(
      "SELECT schema_version, model, dimensions FROM vector_index_meta WHERE id = 1",
    )
    .get();
  if (row === undefined) {
    return null;
  }
  return {
    schemaVersion: requireNumber(row.schema_version, "schema_version"),
    model: requireString(row.model, "model"),
    dimensions: requireNumber(row.dimensions, "dimensions"),
  };
}

/** Returns whether two schema identities describe the same index. */
function sameSpace(
  stored: StoredMetadata,
  metadata: Required<VectorIndexMetadata>,
): boolean {
  return (
    stored.schemaVersion === metadata.schemaVersion &&
    stored.model === metadata.model &&
    stored.dimensions === metadata.dimensions
  );
}

/** Deletes an index file and the journals SQLite keeps beside it. */
function removeDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
}

/** Parses relational vector metadata without using unchecked assertions. */
function parseEntryMetadata(
  row: Record<string, import("node:sqlite").SQLOutputValue>,
): VectorEntryMetadata {
  const kind = requireString(row.entry_kind, "entry_kind");
  if (
    kind !== "node" &&
    kind !== "staging-candidate" &&
    kind !== "document"
  ) {
    throw new VectorIndexError(`Unknown vector entry kind: ${kind}`);
  }

  const title = optionalString(row.title, "title");
  const type = optionalString(row.memory_type, "memory_type");
  const status = optionalString(row.memory_status, "memory_status");
  const modifiedAt = optionalString(row.modified_at, "modified_at");
  const tagsJson = requireString(row.tags_json, "tags_json");
  const tags: unknown = JSON.parse(tagsJson);
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    throw new VectorIndexError("Vector tags_json is invalid.");
  }

  return {
    key: requireString(row.entry_key, "entry_key"),
    kind,
    sourcePath: requireString(row.source_path, "source_path"),
    contentHash: requireString(row.content_hash, "content_hash"),
    ...(title === undefined ? {} : { title }),
    ...(isMemoryType(type) ? { type } : {}),
    ...(isMemoryStatus(status) ? { status } : {}),
    ...(row.decay_weight === null
      ? {}
      : { decayWeight: requireNumber(row.decay_weight, "decay_weight") }),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    tags,
  };
}

/** Validates and normalizes index metadata. */
function validateMetadata(
  options: SqliteVectorIndexOptions,
): Required<VectorIndexMetadata> {
  const model = requireNonEmptyString(options.model, "model");
  if (
    !Number.isInteger(options.dimensions) ||
    options.dimensions < 1 ||
    options.dimensions > MAX_DIMENSIONS
  ) {
    throw new VectorIndexError(
      `Vector dimensions must be an integer from 1 to ${MAX_DIMENSIONS}.`,
    );
  }

  return {
    model,
    dimensions: options.dimensions,
    schemaVersion: options.schemaVersion ?? CURRENT_SCHEMA_VERSION,
  };
}

/** Validates one record before it can enter a transaction. */
function validateRecord(record: VectorRecord, dimensions: number): void {
  requireNonEmptyString(record.key, "key");
  requireNonEmptyString(record.sourcePath, "sourcePath");
  requireNonEmptyString(record.contentHash, "contentHash");
  validateEmbedding(record.embedding, dimensions);
}

/** Validates a dense embedding vector. */
function validateEmbedding(
  embedding: Float32Array,
  dimensions: number,
): void {
  if (embedding.length !== dimensions) {
    throw new VectorIndexError(
      `Embedding has ${embedding.length} dimensions; expected ${dimensions}.`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new VectorIndexError("Embedding contains a non-finite value.");
    }
  }
}

/** Clamps search limit into a practical range. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
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

/** Requires a non-empty string. */
function requireNonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new VectorIndexError(`${field} must not be empty.`);
  }
  return normalized;
}

/**
 * Builds the `AND rowid IN (...)` clause that restricts a nearest-neighbour
 * query to entries matching the filters.
 *
 * The clause has to live inside the vector query: sqlite-vec applies the `k`
 * limit to whatever that query selects, so a filter placed outside it — on the
 * join, or on the results — would only remove candidates after the cutoff and
 * leave a narrow window looking empty.
 */
function buildFilterClause(filters: VectorSearchFilters): {
  sql: string;
  params: Array<string>;
} {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters.kinds !== undefined) {
    if (filters.kinds.length === 0) {
      // No kind can match, so no row can: an empty candidate set, expressed as
      // a condition rather than left to a caller to short-circuit.
      conditions.push("0 = 1");
    } else {
      conditions.push(
        `entry_kind IN (${filters.kinds.map(() => "?").join(", ")})`,
      );
      params.push(...filters.kinds);
    }
  }
  if (filters.type !== undefined) {
    conditions.push("memory_type = ?");
    params.push(filters.type);
  }
  if (filters.status !== undefined) {
    conditions.push("memory_status = ?");
    params.push(filters.status);
  }
  if (filters.since !== undefined) {
    // An entry with no recorded date cannot satisfy a date bound; SQL would
    // otherwise drop it silently for the comparison being NULL.
    conditions.push("modified_at IS NOT NULL AND modified_at >= ?");
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    conditions.push("modified_at IS NOT NULL AND modified_at <= ?");
    params.push(filters.until);
  }

  return {
    sql:
      conditions.length === 0
        ? ""
        : ` AND rowid IN (SELECT rowid FROM vector_entries WHERE ${conditions.join(" AND ")})`,
    params,
  };
}

/** Requires a SQL string result. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new VectorIndexError(`Expected string ${field}.`);
  }
  return value;
}

/** Reads an optional SQL string result. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

/** Requires a SQL numeric result. */
function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VectorIndexError(`Expected numeric ${field}.`);
  }
  return value;
}

/** Requires a SQL integer result represented as bigint or number. */
function requireBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new VectorIndexError(`Expected integer ${field}.`);
}

/** Returns whether a stored value is an approved memory type. */
function isMemoryType(value: string | undefined): value is MemoryType {
  return (
    value === "dream" ||
    value === "fact" ||
    value === "preference" ||
    value === "event" ||
    value === "person-note"
  );
}

/** Returns whether a stored value is an approved memory status. */
function isMemoryStatus(value: string | undefined): value is MemoryStatus {
  return (
    value === "active" ||
    value === "candidate" ||
    value === "superseded" ||
    value === "archived"
  );
}
