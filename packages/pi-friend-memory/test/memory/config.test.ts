/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  DEFAULT_MEMORY_TOOL_PREFIX,
  loadMemoryConfig,
  MemoryConfigError,
  parseMemoryConfig,
} from "../../src/memory/config.ts";
import { withTempDir } from "../helpers.ts";

test("missing configuration uses the default memory root", async () => {
  await withTempDir(async (directory) => {
    const config = await loadMemoryConfig({
      agentDir: directory,
      homeDir: directory,
    });

    assert.equal(
      config.configPath,
      path.join(directory, "pi-friend", "pi-friend.yml"),
    );
    assert.equal(
      config.root,
      path.join(directory, "pi-friend", "memory"),
    );
    assert.equal(config.toolPrefix, "");
    assert.equal(config.toolPrefix, DEFAULT_MEMORY_TOOL_PREFIX);
    assert.deepEqual(config.injection, {
      enabled: true,
      position: -1,
      mode: "hybrid",
      limit: 5,
      maxChars: 6_000,
    });
    assert.deepEqual(config.autoCapture, {
      enabled: true,
      everyTurns: 5,
      maxCandidates: 3,
    });
    assert.deepEqual(config.sweep, {
      enabled: true,
      background: false,
      tombstoneGraceDays: 30,
      minGuardedBatchSize: 10,
    });
    assert.deepEqual(config.dreaming, {
      enabled: true,
      maxNodes: 4,
    });
    assert.deepEqual(config.vector, {
      chunkSize: 4_000,
    });
  });
});

test("configured root expands a leading tilde", () => {
  const configDir = path.join(path.sep, "tmp", "agent", "pi-friend");
  const configPath = path.join(configDir, "pi-friend.yml");
  const config = parseMemoryConfig(
    "memory:\n  root: ~/workspace/memory\n",
    configPath,
    path.join(path.sep, "home", "friend"),
  );

  assert.equal(config.root, path.join(path.sep, "home", "friend", "workspace", "memory"));
});

test("tool prefix is configurable and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    "memory:\n  tool_prefix: pf_\n",
    configPath,
  );

  assert.equal(config.toolPrefix, "pf_");
  const unprefixed = parseMemoryConfig(
    'memory:\n  tool_prefix: ""\n',
    configPath,
  );
  assert.equal(unprefixed.toolPrefix, "");
  for (const prefix of ["PF_", "9bad", "has-hyphen"]) {
    assert.throws(
      () =>
        parseMemoryConfig(
          `memory:\n  tool_prefix: "${prefix}"\n`,
          configPath,
        ),
      MemoryConfigError,
    );
  }
});

test("vector chunk size is configurable and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    "memory:\n  vector:\n    chunk_size: 1200\n",
    configPath,
  );

  assert.equal(config.vector.chunkSize, 1_200);
  for (const source of [
    "memory:\n  vector:\n    chunk_size: 199\n",
    "memory:\n  vector:\n    chunk_size: 20001\n",
    "memory:\n  vector:\n    chunk_size: 12.5\n",
    "memory:\n  vector:\n    chunk_size: large\n",
  ]) {
    assert.throws(
      () => parseMemoryConfig(source, configPath),
      MemoryConfigError,
    );
  }
});

test("prompt configuration is ignored by the memory parser", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  root: ~/memory",
      "prompt:",
      "  unknown: ignored-by-memory",
    ].join("\n"),
    configPath,
    "/Users/example",
  );

  assert.equal(
    config.root,
    path.join("/Users/example", "memory"),
  );
});

test("relative configured roots resolve from the config directory", () => {
  const configDir = path.join(path.sep, "tmp", "agent", "pi-friend");
  const configPath = path.join(configDir, "pi-friend.yml");
  const config = parseMemoryConfig(
    "memory:\n  root: local-memory\n",
    configPath,
  );

  assert.equal(config.root, path.join(configDir, "local-memory"));
});

test("malformed YAML fails closed", () => {
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory: [not closed\n",
        path.join(path.sep, "tmp", "pi-friend.yml"),
      ),
    MemoryConfigError,
  );
});

test("a non-string root fails closed", () => {
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  root: 42\n",
        path.join(path.sep, "tmp", "pi-friend.yml"),
      ),
    /memory\.root must be a non-empty string/,
  );
});

test("the loader reads a custom root from disk", async () => {
  await withTempDir(async (directory) => {
    const configDir = path.join(directory, "pi-friend");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "pi-friend.yml"),
      "memory:\n  root: ~/custom-memory\n",
      "utf8",
    );

    const config = await loadMemoryConfig({
      agentDir: directory,
      homeDir: directory,
    });

    assert.equal(config.root, path.join(directory, "custom-memory"));
  });
});

test("injection settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  injection:",
      "    enabled: false",
      "    position: -2",
      "    mode: keyword",
      "    limit: 3",
      "    max_chars: 1200",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.injection, {
    enabled: false,
    position: -2,
    mode: "keyword",
    limit: 3,
    maxChars: 1_200,
  });
});

test("invalid injection settings fail closed", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  for (const source of [
    "memory:\n  injection:\n    position: 1\n",
    "memory:\n  injection:\n    mode: unknown\n",
    "memory:\n  injection:\n    limit: 0\n",
    "memory:\n  injection:\n    max_chars: 100\n",
    "memory:\n  injection:\n    enabled: yes\n",
  ]) {
    assert.throws(
      () => parseMemoryConfig(source, configPath),
      MemoryConfigError,
    );
  }
});

test("the removed daily injection section is ignored", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  injection:",
      "    daily:",
      "      enabled: false",
    ].join("\n"),
    configPath,
  );

  assert.equal(config.injection.enabled, true);
  assert.equal(config.injection.mode, "hybrid");
});

test("auto-capture settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  auto_capture:",
      "    enabled: false",
      "    every_turns: 2",
      "    max_candidates: 4",
      "    model: openrouter/google/gemini-2.5-flash",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.autoCapture, {
    enabled: false,
    everyTurns: 2,
    maxCandidates: 4,
    model: "openrouter/google/gemini-2.5-flash",
  });
});

test("invalid auto-capture settings fail closed", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  for (const source of [
    "memory:\n  auto_capture:\n    every_turns: 0\n",
    "memory:\n  auto_capture:\n    max_candidates: 0\n",
    "memory:\n  auto_capture:\n    model: nope\n",
    "memory:\n  auto_capture:\n    enabled: sometimes\n",
  ]) {
    assert.throws(
      () => parseMemoryConfig(source, configPath),
      MemoryConfigError,
    );
  }
});

test("sweep settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  sweep:",
      "    enabled: false",
      "    background: true",
      "    tombstone_grace_days: 14",
      "    min_guarded_batch_size: 12",
      "    model: openrouter/google/gemini-2.5-flash",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.sweep, {
    enabled: false,
    background: true,
    tombstoneGraceDays: 14,
    minGuardedBatchSize: 12,
    model: "openrouter/google/gemini-2.5-flash",
  });
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  sweep:\n    background: later\n",
        configPath,
      ),
    MemoryConfigError,
  );
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  sweep:\n    tombstone_grace_days: 0\n",
        configPath,
      ),
    MemoryConfigError,
  );
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  sweep:\n    min_guarded_batch_size: 0\n",
        configPath,
      ),
    MemoryConfigError,
  );
});

test("dreaming settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  dreaming:",
      "    enabled: false",
      "    max_nodes: 3",
      "    model: openrouter/google/gemini-2.5-flash",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.dreaming, {
    enabled: false,
    maxNodes: 3,
    model: "openrouter/google/gemini-2.5-flash",
  });
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  dreaming:\n    max_nodes: 1\n",
        configPath,
      ),
    MemoryConfigError,
  );
});
