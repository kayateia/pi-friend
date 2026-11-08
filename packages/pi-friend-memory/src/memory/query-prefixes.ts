/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueryPrefix } from "./rag-injection.ts";

/** Raised when a configured prefix pattern cannot be used. */
export class QueryPrefixPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryPrefixPatternError";
  }
}

/**
 * Longest prefix pattern accepted from configuration.
 *
 * The same bound as a speaker-tag pattern, for the same reason: a pattern is
 * evaluated against every line of every query, and a pathological expression is
 * a denial of service with good manners.
 */
export const MAX_QUERY_PREFIX_PATTERN_LENGTH = 200;

/**
 * Compiles the patterns a deployment puts in front of a person's words.
 *
 * Unlike a speaker tag, a prefix has no name to capture: the whole match is the
 * markup being removed. Each rejection names the offending pattern by position
 * and text, because a configuration error that does not say which line is wrong
 * sends the reader through the whole file.
 */
export function compileQueryPrefixes(
  sources: readonly string[],
): QueryPrefix[] {
  return sources.map((source, index) => {
    const position = `query prefix pattern ${index + 1}`;
    if (source.trim() === "") {
      throw new QueryPrefixPatternError(`${position} is empty.`);
    }
    if (source.length > MAX_QUERY_PREFIX_PATTERN_LENGTH) {
      throw new QueryPrefixPatternError(
        `${position} is longer than ${MAX_QUERY_PREFIX_PATTERN_LENGTH} characters: ${source}`,
      );
    }
    try {
      return { source, regex: new RegExp(source) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new QueryPrefixPatternError(
        `${position} is not a valid regular expression (${detail}): ${source}`,
      );
    }
  });
}
