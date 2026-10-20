/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseDocument } from "yaml";

/** Raw front-matter and exact body sections from a Markdown file. */
export interface MarkdownFrontMatter {
  frontMatter: string;
  body: string;
}

/** Result of opportunistically parsing a YAML front-matter object. */
export type YamlRecordResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

const FRONT_MATTER_PATTERN =
  /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits strict leading front matter from the exact remaining body. */
export function splitMarkdownFrontMatter(
  text: string,
): MarkdownFrontMatter | null {
  const match = FRONT_MATTER_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  return {
    frontMatter: match[1] ?? "",
    body: text.slice(match[0].length),
  };
}

/**
 * Parses a YAML front-matter object without applying the memory-node schema.
 *
 * Malformed YAML and non-object roots are reported as errors so callers can
 * decide whether to reject a node or index the file as a plain document.
 */
export function parseYamlRecord(source: string): YamlRecordResult {
  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
    version: "1.2",
  });

  if (document.errors.length > 0 || document.warnings.length > 0) {
    const issue = document.errors[0] ?? document.warnings[0];
    return {
      ok: false,
      error: issue?.message ?? "unknown YAML error",
    };
  }

  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (!isRecord(value)) {
    return {
      ok: false,
      error: "Front matter must be a YAML object.",
    };
  }

  return {
    ok: true,
    value,
  };
}

/** Narrows unknown YAML values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
