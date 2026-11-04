/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  DEFAULT_MEMORY_TOOL_PREFIX,
  loadMemoryConfig,
  MemoryConfigError,
  parseMemoryConfig,
} from "../../src/memory/config.ts";
import {
  DREAM_SYSTEM_PROMPT,
  SWEEP_SYSTEM_PROMPT,
  resolveSystemPrompt,
} from "../../src/memory/prompts.ts";
import { withTempDir } from "../helpers.ts";

test("missing configuration uses the default memory root", async () => {
  await withTempDir(async (directory) => {
    const config = await loadMemoryConfig({
      agentDir: directory,
      homeDir: directory,
    });

    assert.equal(
      config.configPath,
      path.join(directory, "pi-friend", "pi-friend-memory.yml"),
    );
    assert.equal(
      config.root,
      path.join(directory, "pi-friend", "memory"),
    );
    assert.equal(config.toolPrefix, "");
    assert.equal(config.toolPrefix, DEFAULT_MEMORY_TOOL_PREFIX);
    assert.deepEqual(config.indexPaths, []);
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
      idleTimeout: 600,
      maxCandidates: 3,
    });
    assert.deepEqual(config.sweep, {
      enabled: true,
      background: false,
      tombstoneGraceDays: 30,
      minGuardedBatchSize: 10,
      allowDrop: false,
      preimageKeep: 3,
    });
    assert.deepEqual(config.dreaming, {
      enabled: true,
      maxNodes: 4,
    });
    assert.deepEqual(config.vector, {
      chunkSize: 4_000,
    });
    assert.deepEqual(config.embeddings, {
      model: "openrouter/openai/text-embedding-3-small",
    });
  });
});

test("configured root expands a leading tilde", () => {
  const configDir = path.join(path.sep, "tmp", "agent", "pi-friend");
  const configPath = path.join(configDir, "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    "memory:\n  root: ~/workspace/memory\n",
    configPath,
    path.join(path.sep, "home", "friend"),
  );

  assert.equal(config.root, path.join(path.sep, "home", "friend", "workspace", "memory"));
});

test("external index paths expand, resolve, and de-duplicate", () => {
  const configDir = path.join(path.sep, "tmp", "agent", "pi-friend");
  const configPath = path.join(configDir, "pi-friend-memory.yml");
  const home = path.join(path.sep, "home", "friend");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  index_paths:",
      "    - ~/notes",
      "    - ../shared-notes",
      "    - ~/notes",
      `    - ${path.join(home, "notes")}`,
    ].join("\n"),
    configPath,
    home,
  );

  assert.deepEqual(config.indexPaths, [
    path.join(home, "notes"),
    path.join(path.sep, "tmp", "agent", "shared-notes"),
  ]);
});

test("invalid external index paths fail closed", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  for (const source of [
    "memory:\n  index_paths: ~/notes\n",
    "memory:\n  index_paths:\n    - 42\n",
    'memory:\n  index_paths:\n    - "  "\n',
  ]) {
    assert.throws(
      () => parseMemoryConfig(source, configPath),
      MemoryConfigError,
    );
  }
});

test("tool prefix is configurable and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
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
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
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
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
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
  // The legacy combined file is still accepted, but silently ignoring an
  // entire section is what used to cost an afternoon, so it is reported.
  assert.match(
    config.warnings.join("\n"),
    /unknown field "prompt" was ignored/,
  );
});

test("relative configured roots resolve from the config directory", () => {
  const configDir = path.join(path.sep, "tmp", "agent", "pi-friend");
  const configPath = path.join(configDir, "pi-friend-memory.yml");
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
        path.join(path.sep, "tmp", "pi-friend-memory.yml"),
      ),
    MemoryConfigError,
  );
});

test("a non-string root fails closed", () => {
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  root: 42\n",
        path.join(path.sep, "tmp", "pi-friend-memory.yml"),
      ),
    /memory\.root must be a non-empty string/,
  );
});

test("the loader reads a custom root from disk", async () => {
  await withTempDir(async (directory) => {
    const configDir = path.join(directory, "pi-friend");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "pi-friend-memory.yml"),
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

test("the loader does not fall back to the legacy shared config", async () => {
  await withTempDir(async (directory) => {
    const configDir = path.join(directory, "pi-friend");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "pi-friend.yml"),
      "memory:\n  root: ~/legacy-memory\n",
      "utf8",
    );

    const config = await loadMemoryConfig({
      agentDir: directory,
      homeDir: directory,
    });

    assert.equal(
      config.configPath,
      path.join(configDir, "pi-friend-memory.yml"),
    );
    assert.equal(config.root, path.join(configDir, "memory"));
  });
});

test("injection settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
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
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
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
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
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
  // Silence here is what makes stale configuration expensive, so the reader is
  // told the section is dead and that nothing succeeds it.
  assert.match(
    config.warnings.join("\n"),
    /memory\.injection\.daily is no longer read: .*daily-log injection feature was removed/,
  );
});

test("auto-capture settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  auto_capture:",
      "    enabled: false",
      "    every_turns: 2",
      "    idle_timeout: 120",
      "    max_candidates: 4",
      "    model: openrouter/google/gemini-2.5-flash",
      "    prompt: |",
      "      Custom capture prompt.",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.autoCapture, {
    enabled: false,
    everyTurns: 2,
    idleTimeout: 120,
    maxCandidates: 4,
    model: "openrouter/google/gemini-2.5-flash",
    prompt: "Custom capture prompt.",
  });
});

test("invalid auto-capture settings fail closed", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  for (const source of [
    "memory:\n  auto_capture:\n    every_turns: 0\n",
    "memory:\n  auto_capture:\n    idle_timeout: 0\n",
    "memory:\n  auto_capture:\n    max_candidates: 0\n",
    "memory:\n  auto_capture:\n    model: nope\n",
    'memory:\n  auto_capture:\n    prompt: "  "\n',
    "memory:\n  auto_capture:\n    enabled: sometimes\n",
  ]) {
    assert.throws(
      () => parseMemoryConfig(source, configPath),
      MemoryConfigError,
    );
  }
});

test("sweep settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  sweep:",
      "    enabled: false",
      "    background: true",
      "    tombstone_grace_days: 14",
      "    min_guarded_batch_size: 12",
      "    model: openrouter/google/gemini-2.5-flash",
      "    prompt: |",
      "      Custom sweep prompt.",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.sweep, {
    enabled: false,
    background: true,
    tombstoneGraceDays: 14,
    minGuardedBatchSize: 12,
    preimageKeep: 3,
    allowDrop: false,
    model: "openrouter/google/gemini-2.5-flash",
    prompt: "Custom sweep prompt.",
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
  assert.throws(
    () =>
      parseMemoryConfig(
        'memory:\n  sweep:\n    prompt: "  "\n',
        configPath,
      ),
    MemoryConfigError,
  );
});

test("dreaming settings are parsed and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  dreaming:",
      "    enabled: false",
      "    max_nodes: 3",
      "    model: openrouter/google/gemini-2.5-flash",
      "    prompt: |",
      "      Custom dream prompt.",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.dreaming, {
    enabled: false,
    maxNodes: 3,
    model: "openrouter/google/gemini-2.5-flash",
    prompt: "Custom dream prompt.",
  });
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  dreaming:\n    max_nodes: 1\n",
        configPath,
      ),
    MemoryConfigError,
  );
  assert.throws(
    () =>
      parseMemoryConfig(
        'memory:\n  dreaming:\n    prompt: "  "\n',
        configPath,
      ),
    MemoryConfigError,
  );
});

test("embedding model is configurable and validated", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    "memory:\n  embeddings:\n    model: openrouter/openai/text-embedding-3-large\n",
    configPath,
  );
  assert.equal(
    config.embeddings.model,
    "openrouter/openai/text-embedding-3-large",
  );
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  embeddings:\n    model: invalid\n",
        configPath,
      ),
    MemoryConfigError,
  );
});

test("prompt_append keeps the built-in prompt and adds house guidance", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  sweeping: false",
      "  sweep:",
      "    prompt_append: |",
      "      Prefer promoting a distinct new fact over merging it into a broad node.",
    ].join("\n"),
    configPath,
  );

  assert.equal(config.sweep.prompt, undefined);
  assert.match(config.sweep.promptAppend ?? "", /Prefer promoting/);
  assert.equal(
    resolveSystemPrompt(SWEEP_SYSTEM_PROMPT, config.sweep),
    `${SWEEP_SYSTEM_PROMPT}\n\nPrefer promoting a distinct new fact over merging it into a broad node.`,
  );
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0] ?? "", /unknown field "sweeping"/);
});

test("prompt and prompt_append cannot be combined", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  assert.throws(
    () =>
      parseMemoryConfig(
        [
          "memory:",
          "  sweep:",
          "    prompt: Replace everything.",
          "    prompt_append: Add to it.",
        ].join("\n"),
        configPath,
      ),
    (error: unknown) =>
      error instanceof MemoryConfigError &&
      error.message.includes("memory.sweep.prompt") &&
      error.message.includes("memory.sweep.prompt_append"),
  );
});

test("a replacement prompt leaves the built-in text untouched upstream", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    "memory:\n  dreaming:\n    prompt: Only dream in haiku.\n",
    configPath,
  );

  assert.equal(config.dreaming.prompt, "Only dream in haiku.");
  assert.equal(config.dreaming.promptAppend, undefined);
  assert.equal(
    resolveSystemPrompt(DREAM_SYSTEM_PROMPT, config.dreaming),
    "Only dream in haiku.",
  );
});

test("prompt text naming vocabulary the code cannot honour is reported", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  auto_capture:",
      "    prompt: |",
      "      When the speaker cannot be determined, use 'unknown' for them.",
      "  sweep:",
      "    prompt: |",
      "      Choose drop for anything operational, otherwise promote.",
    ].join("\n"),
    configPath,
  );

  const joined = config.warnings.join("\n");
  assert.match(joined, /attribute a speaker as "unknown"/);
  assert.match(joined, /drop.*not a sweep action/);
});

test("ordinary prose that resembles vocabulary does not warn", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  auto_capture:",
      "    prompt_append: |",
      "      Care about the inner life of the person, and never label a",
      "      speaker USER or ASSISTANT.",
      "  dreaming:",
      "    prompt_append: |",
      "      A thoughtful aside is welcome; keep it short.",
    ].join("\n"),
    configPath,
  );

  assert.deepEqual(config.warnings, []);
});

test("built-in prompts and the example configuration produce no warnings", async () => {
  const examplePath = path.resolve("pi-friend-memory.example.yml");
  const config = parseMemoryConfig(
    await readFile(examplePath, "utf8"),
    examplePath,
  );
  assert.deepEqual(config.warnings, []);
});

test("allow_drop is off by default and must be a boolean", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  assert.equal(
    parseMemoryConfig("memory:\n  sweep:\n    enabled: true\n", configPath)
      .sweep.allowDrop,
    false,
  );
  assert.equal(
    parseMemoryConfig(
      "memory:\n  sweep:\n    allow_drop: true\n",
      configPath,
    ).sweep.allowDrop,
    true,
  );
  assert.throws(
    () =>
      parseMemoryConfig(
        'memory:\n  sweep:\n    allow_drop: "yes"\n',
        configPath,
      ),
    MemoryConfigError,
  );
});

test("drop stops being a near-miss once allow_drop is enabled", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const allowed = parseMemoryConfig(
    [
      "memory:",
      "  sweep:",
      "    allow_drop: true",
      "    prompt_append: |",
      "      Choose drop for anything that misread the speaker.",
    ].join("\n"),
    configPath,
  );
  assert.deepEqual(allowed.warnings, []);

  const refused = parseMemoryConfig(
    [
      "memory:",
      "  sweep:",
      "    prompt_append: |",
      "      Choose drop for anything that misread the speaker.",
    ].join("\n"),
    configPath,
  );
  assert.match(refused.warnings.join("\n"), /not a sweep action/);
});

test("a replacement sweep prompt that never mentions drop is reported", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  const config = parseMemoryConfig(
    [
      "memory:",
      "  sweep:",
      "    allow_drop: true",
      "    prompt: Promote or merge; prefer merge.",
    ].join("\n"),
    configPath,
  );
  assert.match(
    config.warnings.join("\n"),
    /allow_drop is enabled but memory\.sweep\.prompt never mentions drop/,
  );
});

test("preimage_keep defaults to a bounded number and accepts zero", () => {
  const configPath = path.join(path.sep, "tmp", "pi-friend-memory.yml");
  assert.equal(
    parseMemoryConfig("memory:\n  root: ~/memory\n", configPath).sweep
      .preimageKeep,
    3,
  );
  assert.equal(
    parseMemoryConfig(
      "memory:\n  sweep:\n    preimage_keep: 0\n",
      configPath,
    ).sweep.preimageKeep,
    0,
  );
  for (const invalid of ['"two"', "-1", "101", "1.5"]) {
    assert.throws(
      () =>
        parseMemoryConfig(
          `memory:\n  sweep:\n    preimage_keep: ${invalid}\n`,
          configPath,
        ),
      MemoryConfigError,
      invalid,
    );
  }
});
