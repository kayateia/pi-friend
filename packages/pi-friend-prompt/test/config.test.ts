/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  getSharedConfigPath,
  loadPromptConfig,
  parsePromptConfig,
  PromptConfigError,
} from "../src/config.ts";

test("prompt config reads only the prompt section of the shared file", () => {
  const config = parsePromptConfig(
    [
      "memory:",
      "  root: ~/memory",
      "prompt:",
      "  custom: |",
      "    You are Lime.",
    ].join("\n"),
    "/tmp/pi-friend.yml",
  );

  assert.equal(config.customPrompt, "You are Lime.");
});

test("missing and empty prompt sections are no-ops", () => {
  assert.equal(
    parsePromptConfig("memory:\n  root: ~/memory\n", "/tmp/config.yml")
      .customPrompt,
    undefined,
  );
  assert.equal(
    parsePromptConfig("prompt:\n  custom: ''\n", "/tmp/config.yml")
      .customPrompt,
    undefined,
  );
});

test("malformed prompt sections fail closed", () => {
  for (const source of [
    "prompt: text\n",
    "prompt:\n  custom: 42\n",
    "prompt:\n  unknown: value\n",
  ]) {
    assert.throws(
      () => parsePromptConfig(source, "/tmp/config.yml"),
      PromptConfigError,
    );
  }
});

test("prompt config loads from the shared Pi agent path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-config-"));
  try {
    const configPath = getSharedConfigPath(directory);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      "prompt:\n  custom: Configured narrative.\n",
      "utf8",
    );

    const config = await loadPromptConfig({ agentDir: directory });
    assert.equal(config.customPrompt, "Configured narrative.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
