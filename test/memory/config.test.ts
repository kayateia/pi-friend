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
