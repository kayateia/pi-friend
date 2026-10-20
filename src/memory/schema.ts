/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import { parseDocument, stringify } from "yaml";
import type { MemoryFileKind } from "./paths.ts";
import { MemoryPathError, validateSlug } from "./paths.ts";

/** Approved semantic categories for memory nodes. */
export const MEMORY_TYPES = [
  "dream",
  "fact",
  "preference",
  "event",
  "person-note",
] as const;

/** One approved memory node type. */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Lifecycle states for memory nodes. */
export const MEMORY_STATUSES = [
  "active",
  "candidate",
  "superseded",
  "archived",
] as const;

/** One approved memory node lifecycle state. */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** One attributed speaker in a memory node. */
export interface MemorySpeaker {
  name: string;
  confident: boolean;
  note?: string;
}

/** Strict front matter stored at the top of every memory node. */
export interface MemoryNodeFrontMatter {
  title: string;
  type: MemoryType;
  speaker: MemorySpeaker[];
  agents: string[];
  created: string;
  last_used: string;
  use_count: number;
  decay_weight: number;
  status: MemoryStatus;
  emotional_flavor: string;
  tags: string[];
  supersedes: string[];
  superseded_by: string;
  links: string[];
  source: string;
  edited?: string;
}

/** A fully parsed memory node, including its exact Markdown body. */
export interface ParsedMemoryNode {
  slug: string;
  frontMatter: MemoryNodeFrontMatter;
  /** Exact text after the closing front-matter delimiter. */
  body: string;
}

/** Storage location information used for location-aware validation. */
export interface MemoryNodeLocation {
  kind: MemoryFileKind;
  relativePath: string;
}

/** Error raised when a memory node has invalid or inconsistent metadata. */
export class MemorySchemaError extends Error {
  readonly field: string | undefined;

  constructor(
    message: string,
    options: { field?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MemorySchemaError";
    this.field = options.field;
  }
}

const FRONT_MATTER_PATTERN =
  /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const FRONT_MATTER_KEYS = new Set([
  "title",
  "type",
  "speaker",
  "agents",
  "created",
  "last_used",
  "use_count",
  "decay_weight",
  "status",
  "emotional_flavor",
  "tags",
  "supersedes",
  "superseded_by",
  "links",
  "source",
  "edited",
]);

const REQUIRED_FRONT_MATTER_KEYS = [
  "title",
  "type",
  "speaker",
  "agents",
  "created",
  "last_used",
  "use_count",
  "decay_weight",
  "status",
  "emotional_flavor",
  "tags",
  "supersedes",
  "superseded_by",
  "links",
] as const;

const SPEAKER_KEYS = new Set(["name", "confident", "note"]);

/**
 * Parses and validates a memory node from its complete Markdown text.
 *
 * The returned body is an exact suffix of the source and is never normalized.
 */
export function parseMemoryNode(
  text: string,
  slug: string,
  location?: MemoryNodeLocation,
): ParsedMemoryNode {
  const validSlug = validateSlugForSchema(slug, "slug");
  const sections = splitFrontMatter(text, validSlug);
  const document = parseDocument(sections.frontMatter, {
    prettyErrors: true,
    uniqueKeys: true,
    version: "1.2",
  });

  if (document.errors.length > 0 || document.warnings.length > 0) {
    const issue = document.errors[0] ?? document.warnings[0];
    throw new MemorySchemaError(
      `Invalid YAML front matter for ${validSlug}: ${issue?.message ?? "unknown YAML error"}`,
      { cause: issue },
    );
  }

  const value: unknown = document.toJS({ maxAliasCount: 50 });
  const frontMatter = validateMemoryNodeFrontMatter(value, validSlug);
  const node: ParsedMemoryNode = {
    slug: validSlug,
    frontMatter,
    body: sections.body,
  };

  if (location) {
    validateMemoryNodeLocation(node, location);
  }

  return node;
}

/** Parses a node file and derives its slug from the filename. */
export function parseMemoryNodeFile(
  text: string,
  location: MemoryNodeLocation,
): ParsedMemoryNode {
  if (location.kind === "document") {
    throw new MemorySchemaError(
      `${location.relativePath} is a plain document, not a memory node.`,
    );
  }
  if (!location.relativePath.endsWith(".md")) {
    throw new MemorySchemaError(
      `${location.relativePath} must use the .md extension.`,
    );
  }

  const slug = path.basename(location.relativePath, ".md");
  return parseMemoryNode(text, slug, location);
}

/** Validates an already-decoded front-matter value. */
export function validateMemoryNodeFrontMatter(
  value: unknown,
  slug: string,
): MemoryNodeFrontMatter {
  validateSlugForSchema(slug, "slug");

  if (!isRecord(value)) {
    throw new MemorySchemaError(
      `Front matter for ${slug} must be a YAML object.`,
    );
  }

  for (const key of Object.keys(value)) {
    if (!FRONT_MATTER_KEYS.has(key)) {
      throw new MemorySchemaError(
        `Unknown front-matter field "${key}" in ${slug}.`,
        { field: key },
      );
    }
  }

  for (const key of REQUIRED_FRONT_MATTER_KEYS) {
    if (!(key in value)) {
      throw new MemorySchemaError(
        `Missing required front-matter field "${key}" in ${slug}.`,
        { field: key },
      );
    }
  }

  const title = requireNonEmptyString(value.title, "title", slug);
  const type = requireEnum(value.type, MEMORY_TYPES, "type", slug);
  const speaker = parseSpeakers(value.speaker, slug);
  const agents = parseStringList(value.agents, "agents", slug);
  const created = requireTimestamp(value.created, "created", slug);
  const lastUsed = requireTimestamp(value.last_used, "last_used", slug);
  const useCount = requireNonNegativeInteger(value.use_count, "use_count", slug);
  const decayWeight = requireDecayWeight(value.decay_weight, slug);
  const status = requireEnum(value.status, MEMORY_STATUSES, "status", slug);
  const emotionalFlavor = requireString(
    value.emotional_flavor,
    "emotional_flavor",
    slug,
  ).trim();
  const tags = parseStringList(value.tags, "tags", slug);
  const supersedes = parseSlugList(value.supersedes, "supersedes", slug);
  const supersededBy = requireSlugOrEmpty(
    value.superseded_by,
    "superseded_by",
    slug,
  );
  const links = parseSlugList(value.links, "links", slug);
  const source =
    value.source === undefined
      ? ""
      : requireString(value.source, "source", slug).trim();
  const edited =
    value.edited === undefined
      ? undefined
      : requireTimestamp(value.edited, "edited", slug);

  if (Date.parse(lastUsed) < Date.parse(created)) {
    throw new MemorySchemaError(
      `last_used must not be earlier than created in ${slug}.`,
      { field: "last_used" },
    );
  }
  if (edited !== undefined && Date.parse(edited) < Date.parse(created)) {
    throw new MemorySchemaError(
      `edited must not be earlier than created in ${slug}.`,
      { field: "edited" },
    );
  }

  if (supersedes.includes(slug)) {
    throw new MemorySchemaError(
      `${slug} must not supersede itself.`,
      { field: "supersedes" },
    );
  }
  if (supersededBy === slug) {
    throw new MemorySchemaError(
      `${slug} must not be superseded by itself.`,
      { field: "superseded_by" },
    );
  }

  const claimsSupersession = supersededBy !== "";
  const hasSupersededStatus = status === "superseded";
  if (claimsSupersession !== hasSupersededStatus) {
    throw new MemorySchemaError(
      `status and superseded_by must agree in ${slug}.`,
      { field: "superseded_by" },
    );
  }
  if (hasSupersededStatus && decayWeight !== 0) {
    throw new MemorySchemaError(
      `Superseded node ${slug} must have decay_weight 0.`,
      { field: "decay_weight" },
    );
  }

  return {
    title,
    type,
    speaker,
    agents,
    created,
    last_used: lastUsed,
    use_count: useCount,
    decay_weight: decayWeight,
    status,
    emotional_flavor: emotionalFlavor,
    tags,
    supersedes,
    superseded_by: supersededBy,
    links,
    source,
    ...(edited === undefined ? {} : { edited }),
  };
}

/** Enforces status and type rules implied by a node's storage location. */
export function validateMemoryNodeLocation(
  node: ParsedMemoryNode,
  location: MemoryNodeLocation,
): void {
  if (location.kind === "document") {
    throw new MemorySchemaError(
      `${location.relativePath} is a plain document, not a memory node.`,
    );
  }

  if (
    location.kind === "staging-candidate" &&
    node.frontMatter.status !== "candidate"
  ) {
    throw new MemorySchemaError(
      `Staging node ${node.slug} must have status "candidate".`,
      { field: "status" },
    );
  }

  if (location.kind === "node" && node.frontMatter.status === "candidate") {
    throw new MemorySchemaError(
      `Canonical node ${node.slug} must not retain candidate status.`,
      { field: "status" },
    );
  }

  if (
    location.kind === "staging-candidate" &&
    node.frontMatter.type === "dream"
  ) {
    throw new MemorySchemaError(
      `Dream node ${node.slug} cannot be a staging candidate.`,
      { field: "type" },
    );
  }

  const normalizedPath = location.relativePath.split(path.sep).join("/");
  if (
    normalizedPath.startsWith("nodes/superseded/") &&
    node.frontMatter.status !== "superseded"
  ) {
    throw new MemorySchemaError(
      `Node ${node.slug} in nodes/superseded must have status "superseded".`,
      { field: "status" },
    );
  }
}

/** Serializes a parsed node with deterministic front matter and exact body. */
export function serializeMemoryNode(node: ParsedMemoryNode): string {
  const validSlug = validateSlugForSchema(node.slug, "slug");
  const frontMatter = validateMemoryNodeFrontMatter(node.frontMatter, validSlug);
  if (node.body.trim() === "") {
    throw new MemorySchemaError(`Memory node ${validSlug} must have a body.`, {
      field: "body",
    });
  }

  const orderedFrontMatter: MemoryNodeFrontMatter = {
    title: frontMatter.title,
    type: frontMatter.type,
    speaker: frontMatter.speaker,
    agents: frontMatter.agents,
    created: frontMatter.created,
    last_used: frontMatter.last_used,
    use_count: frontMatter.use_count,
    decay_weight: frontMatter.decay_weight,
    status: frontMatter.status,
    emotional_flavor: frontMatter.emotional_flavor,
    tags: frontMatter.tags,
    supersedes: frontMatter.supersedes,
    superseded_by: frontMatter.superseded_by,
    links: frontMatter.links,
    source: frontMatter.source,
    ...(frontMatter.edited === undefined ? {} : { edited: frontMatter.edited }),
  };

  const yamlSource = stringify(orderedFrontMatter, {
    lineWidth: 0,
    version: "1.2",
  });

  return `---\n${yamlSource}---\n${node.body}`;
}

/** Splits delimiters from YAML and preserves the remaining body exactly. */
function splitFrontMatter(
  text: string,
  slug: string,
): { frontMatter: string; body: string } {
  const match = FRONT_MATTER_PATTERN.exec(text);
  if (!match) {
    throw new MemorySchemaError(
      `Memory node ${slug} must start with strict YAML front matter.`,
    );
  }

  const body = text.slice(match[0].length);
  if (body.trim() === "") {
    throw new MemorySchemaError(`Memory node ${slug} must have a body.`, {
      field: "body",
    });
  }

  return {
    frontMatter: match[1] ?? "",
    body,
  };
}

/** Parses ordered speaker attribution records. */
function parseSpeakers(value: unknown, slug: string): MemorySpeaker[] {
  if (!Array.isArray(value)) {
    throw fieldTypeError("speaker", "an array", slug);
  }

  return value.map((speakerValue, index) => {
    const field = `speaker[${index}]`;
    if (!isRecord(speakerValue)) {
      throw fieldTypeError(field, "an object", slug);
    }

    for (const key of Object.keys(speakerValue)) {
      if (!SPEAKER_KEYS.has(key)) {
        throw new MemorySchemaError(
          `Unknown field "${key}" in ${field} for ${slug}.`,
          { field: `${field}.${key}` },
        );
      }
    }

    if (!("name" in speakerValue) || !("confident" in speakerValue)) {
      throw new MemorySchemaError(
        `${field} in ${slug} requires name and confident.`,
        { field },
      );
    }

    const name = requireNonEmptyString(
      speakerValue.name,
      `${field}.name`,
      slug,
    );
    if (typeof speakerValue.confident !== "boolean") {
      throw fieldTypeError(`${field}.confident`, "a boolean", slug);
    }

    const note =
      speakerValue.note === undefined
        ? undefined
        : requireString(speakerValue.note, `${field}.note`, slug).trim();

    return {
      name,
      confident: speakerValue.confident,
      ...(note === undefined ? {} : { note }),
    };
  });
}

/** Parses a unique, non-empty string list while preserving order. */
function parseStringList(
  value: unknown,
  field: string,
  slug: string,
): string[] {
  if (!Array.isArray(value)) {
    throw fieldTypeError(field, "an array", slug);
  }

  const items = value.map((item, index) => {
    if (typeof item !== "string") {
      throw fieldTypeError(`${field}[${index}]`, "a string", slug);
    }

    const normalized = item.trim();
    if (normalized === "") {
      throw new MemorySchemaError(
        `${field}[${index}] in ${slug} must not be empty.`,
        { field: `${field}[${index}]` },
      );
    }
    return normalized;
  });

  rejectDuplicates(items, field, slug);
  return items;
}

/** Parses and validates a unique list of memory slugs. */
function parseSlugList(
  value: unknown,
  field: string,
  slug: string,
): string[] {
  const items = parseStringList(value, field, slug).map((item) =>
    validateSlugForSchema(item, field),
  );
  rejectDuplicates(items, field, slug);
  return items;
}

/** Rejects duplicate values in a normalized list. */
function rejectDuplicates(
  values: string[],
  field: string,
  slug: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new MemorySchemaError(
        `Duplicate value "${value}" in ${field} for ${slug}.`,
        { field },
      );
    }
    seen.add(value);
  }
}

/** Validates a slug reference using the shared path-safety rules. */
function validateSlugForSchema(value: string, field: string): string {
  try {
    return validateSlug(value);
  } catch (error) {
    if (error instanceof MemoryPathError) {
      throw new MemorySchemaError(`Invalid slug in ${field}: ${error.message}`, {
        field,
        cause: error,
      });
    }
    throw error;
  }
}

/** Validates an empty string or a canonical memory slug. */
function requireSlugOrEmpty(
  value: unknown,
  field: string,
  slug: string,
): string {
  if (typeof value !== "string") {
    throw fieldTypeError(field, "a string", slug);
  }

  const normalized = value.trim();
  return normalized === "" ? "" : validateSlugForSchema(normalized, field);
}

/** Requires a non-empty trimmed string. */
function requireNonEmptyString(
  value: unknown,
  field: string,
  slug: string,
): string {
  const text = requireString(value, field, slug).trim();
  if (text === "") {
    throw new MemorySchemaError(`${field} in ${slug} must not be empty.`, {
      field,
    });
  }
  return text;
}

/** Requires a string value without trimming it. */
function requireString(value: unknown, field: string, slug: string): string {
  if (typeof value !== "string") {
    throw fieldTypeError(field, "a string", slug);
  }
  return value;
}

/** Requires a value from one of the approved constant lists. */
function requireEnum<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
  slug: string,
): T {
  if (typeof value !== "string") {
    throw new MemorySchemaError(
      `${field} in ${slug} must be one of: ${choices.join(", ")}.`,
      { field },
    );
  }

  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) {
    throw new MemorySchemaError(
      `${field} in ${slug} must be one of: ${choices.join(", ")}.`,
      { field },
    );
  }

  return selected;
}

/** Requires a valid ISO-8601 timestamp with an explicit timezone. */
function requireTimestamp(
  value: unknown,
  field: string,
  slug: string,
): string {
  if (typeof value !== "string") {
    throw fieldTypeError(field, "an ISO-8601 timestamp string", slug);
  }

  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match || !isValidCalendarTimestamp(match)) {
    throw new MemorySchemaError(
      `${field} in ${slug} must be a valid ISO-8601 timestamp with a timezone.`,
      { field },
    );
  }

  return value;
}

/** Confirms calendar components before relying on Date.parse. */
function isValidCalendarTimestamp(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(match[0]))
  );
}

/** Requires a nonnegative integer. */
function requireNonNegativeInteger(
  value: unknown,
  field: string,
  slug: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw fieldTypeError(field, "a nonnegative integer", slug);
  }
  return value;
}

/** Requires a finite decay weight between zero and one. */
function requireDecayWeight(value: unknown, slug: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new MemorySchemaError(
      `decay_weight in ${slug} must be a finite number from 0 to 1.`,
      { field: "decay_weight" },
    );
  }
  return value;
}

/** Creates a consistent type error for a schema field. */
function fieldTypeError(
  field: string,
  expected: string,
  slug: string,
): MemorySchemaError {
  return new MemorySchemaError(`${field} in ${slug} must be ${expected}.`, {
    field,
  });
}

/** Narrows unknown YAML values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
