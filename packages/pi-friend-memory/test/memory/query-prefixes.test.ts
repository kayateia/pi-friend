/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConfigError, parseMemoryConfig } from "../../src/memory/config.ts";
import {
  QueryPrefixPatternError,
  compileQueryPrefixes,
} from "../../src/memory/query-prefixes.ts";

test("a prefix is removed from the start of every line", () => {
  const prefixes = compileQueryPrefixes(["^\\[\\d{2}:\\d{2}\\] "]);
  assert.deepEqual(
    prefixes.map((prefix) => prefix.regex.source),
    ["^\\[\\d{2}:\\d{2}\\] "],
  );
});

test("an unusable prefix pattern is rejected by position and text", () => {
  const cases: Array<{ pattern: string; message: RegExp }> = [
    { pattern: "", message: /pattern 1 is empty/u },
    { pattern: "(", message: /pattern 1 is not a valid regular expression/u },
    {
      pattern: `^(${"a".repeat(300)})`,
      message: /pattern 1 is longer than 200 characters/u,
    },
  ];
  for (const example of cases) {
    assert.throws(
      () => compileQueryPrefixes([example.pattern]),
      (error: unknown) =>
        error instanceof QueryPrefixPatternError &&
        example.message.test(error.message),
    );
  }
});

test("memory.query_prefixes.patterns configures the list", () => {
  const config = parseMemoryConfig(
    ["memory:", "  query_prefixes:", "    patterns:", "      - '^\\[\\d{2}:\\d{2}\\] '"].join("\n"),
    "/tmp/pi-friend/pi-friend-memory.yml",
    "/tmp",
  );
  assert.deepEqual(config.queryPrefixes.patterns, ["^\\[\\d{2}:\\d{2}\\] "]);
});

test("the default is no prefixes, because what a deployment injects is its own", () => {
  const config = parseMemoryConfig(
    "memory:\n  root: ~/memory",
    "/tmp/pi-friend/pi-friend-memory.yml",
    "/tmp",
  );
  assert.deepEqual(config.queryPrefixes.patterns, []);
});

test("an unusable query prefix is a configuration error", () => {
  const cases = [
    {
      body: ["  query_prefixes:", "    patterns: ['(']"].join("\n"),
      message: /not a valid regular expression/u,
    },
    {
      body: ["  query_prefixes:", "    patterns: [42]"].join("\n"),
      message: /patterns\[0\] must be a non-empty string/u,
    },
    {
      body: ["  query_prefixes:", "    patterns: 'x'"].join("\n"),
      message: /must be a list of regular expressions/u,
    },
  ];
  for (const example of cases) {
    assert.throws(
      () =>
        parseMemoryConfig(
          `memory:\n${example.body}`,
          "/tmp/pi-friend/pi-friend-memory.yml",
          "/tmp",
        ),
      (error: unknown) =>
        error instanceof MemoryConfigError && example.message.test(error.message),
    );
  }
});
