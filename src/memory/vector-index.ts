/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
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
  tags?: string[];
}

/** One nearest-neighbor result. */
export interface VectorSearchHit {
  key: string;
  kind: MemoryFileKind;
  sourcePath: string;
  contentHash: string;
  distance: number;
  title?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  decayWeight?: number;
  tags: string[];
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
  search(embedding: Float32Array, limit?: number): VectorSearchHit[];
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

const CURRENT_SCHEMA_VERSION = 1;
const MAX_DIMENSIONS = 8_192;
const DEFAULT_SEARCH_LIMIT = 5;

/**
 * Disposable sqlite-vec index.
 *
 * Canonical Markdown remains outside this class. Every operation here may be
 * reproduced by rebuilding from indexed records.
 */
export class SqliteVectorIndex implements VectorIndex {
  readonly metadata: Required<VectorIndexMetadata>;
  readonly databasePath: string;
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

    this.database = new DatabaseSync(options.databasePath, {
      allowExtension: true,
      timeout: 5_000,
    });

    try {
      sqliteVec.load(this.database);
      this.database.enableLoadExtension(false);
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      this.initializeSchema();
      if (options.databasePath !== ":memory:") {
        chmodSync(options.databasePath, 0o600);
      }
    } catch (error) {
      this.database.close();
      throw new VectorIndexError(
        `Could not initialize sqlite-vec index at ${options.databasePath}.`,
        { cause: error },
      );
    }
  }

  /** Inserts or replaces one vector record transactionally. */
  upsert(record: VectorRecord): void {
    validateRecord(record, this.metadata.dimensions);
    this.transaction(() => this.upsertWithoutTransaction(record));
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

  /** Searches nearest vectors using cosine distance. */
  search(embedding: Float32Array, limit = DEFAULT_SEARCH_LIMIT): VectorSearchHit[] {
    validateEmbedding(embedding, this.metadata.dimensions);
    const safeLimit = clampLimit(limit);
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
            entries.tags_json,
            nearest.distance
          FROM (
            SELECT rowid, distance
            FROM vector_embeddings
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
          ) AS nearest
          JOIN vector_entries AS entries ON entries.rowid = nearest.rowid
          ORDER BY nearest.distance
        `,
      )
      .all(embedding, safeLimit);

    return rows.map(parseSearchRow);
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
  private initializeSchema(): void {
    this.database.exec(`
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
        tags_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const stored = this.database
      .prepare(
        "SELECT schema_version, model, dimensions FROM vector_index_meta WHERE id = 1",
      )
      .get();

    if (stored === undefined) {
      this.database
        .prepare(
          "INSERT INTO vector_index_meta(id, schema_version, model, dimensions) VALUES (1, ?, ?, ?)",
        )
        .run(
          this.metadata.schemaVersion,
          this.metadata.model,
          this.metadata.dimensions,
        );
    } else {
      const schemaVersion = requireNumber(
        stored.schema_version,
        "schema_version",
      );
      const storedDimensions = requireNumber(stored.dimensions, "dimensions");
      const storedModel = requireString(stored.model, "model");
      if (
        schemaVersion !== this.metadata.schemaVersion ||
        storedDimensions !== this.metadata.dimensions ||
        storedModel !== this.metadata.model
      ) {
        throw new VectorIndexError(
          "Vector index metadata does not match the requested model or dimensions; rebuild the index.",
        );
      }
    }

    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vector_embeddings USING vec0(
        embedding float[${this.metadata.dimensions}] distance_metric=cosine
      );
    `);
  }

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
      } catch {
        // Preserve the original operation error.
      }
      throw error;
    }
  }

  /** Performs an upsert while the caller owns the transaction. */
  private upsertWithoutTransaction(record: VectorRecord): void {
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
            tags_json,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_key) DO UPDATE SET
            entry_kind = excluded.entry_kind,
            source_path = excluded.source_path,
            content_hash = excluded.content_hash,
            title = excluded.title,
            memory_type = excluded.memory_type,
            memory_status = excluded.memory_status,
            decay_weight = excluded.decay_weight,
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
        JSON.stringify(record.tags ?? []),
        new Date().toISOString(),
      );

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

/** Parses one joined vector-search row without using unchecked assertions. */
function parseSearchRow(
  row: Record<string, import("node:sqlite").SQLOutputValue>,
): VectorSearchHit {
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
    distance: requireNumber(row.distance, "distance"),
    ...(title === undefined ? {} : { title }),
    ...(isMemoryType(type) ? { type } : {}),
    ...(isMemoryStatus(status) ? { status } : {}),
    ...(row.decay_weight === null
      ? {}
      : { decayWeight: requireNumber(row.decay_weight, "decay_weight") }),
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

/** Requires a non-empty string. */
function requireNonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new VectorIndexError(`${field} must not be empty.`);
  }
  return normalized;
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
