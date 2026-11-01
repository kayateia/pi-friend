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
  hasPromptEdits,
  loadPromptConfig,
  parsePromptConfig,
  PromptConfigError,
} from "../src/config.ts";

test("prompt config preserves the scalar custom prompt form", () => {
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

  assert.deepEqual(config.custom, {
    text: "You are Lime.",
    files: [],
  });
  assert.equal(hasPromptEdits(config), true);
});

test("prompt config parses file-backed slots and replacement rules", () => {
  const config = parsePromptConfig(
    [
      "prompt:",
      "  custom:",
      "    text: Configured narrative.",
      "    files:",
      "      - persona/core.md",
      "      - persona/local.md",
      "  addendum:",
      "    files:",
      "      - addendum.md",
      "  sections:",
      "    house_rules: Shared conventions.",
      "    project_context:",
      "      files: [context.md]",
      "  replacements:",
      "    - section: addendum",
      "      action: append",
      "      replacement_file: extra.md",
      "    - section: rules",
      "      pattern: '^- Be concise.*$'",
      "      flags: gm",
      "      replacement: '- Stay focused'",
    ].join("\n"),
    "/tmp/pi-friend.yml",
  );

  assert.deepEqual(config.custom, {
    text: "Configured narrative.",
    files: ["persona/core.md", "persona/local.md"],
  });
  assert.deepEqual(config.addendum, {
    files: ["addendum.md"],
  });
  assert.deepEqual(config.sections.house_rules, {
    text: "Shared conventions.",
    files: [],
  });
  assert.deepEqual(config.sections.project_context, {
    files: ["context.md"],
  });
  assert.deepEqual(config.replacements, [
    {
      section: "addendum",
      action: "append",
      flags: "",
      replacementFile: "extra.md",
    },
    {
      section: "rules",
      action: "replace",
      pattern: "^- Be concise.*$",
      flags: "gm",
      replacement: "- Stay focused",
    },
  ]);
});

test("missing and empty prompt sections are no-ops", () => {
  for (const source of [
    "memory:\n  root: ~/memory\n",
    "prompt:\n  custom: ''\n",
    "prompt:\n  custom:\n    files: []\n",
  ]) {
    const config = parsePromptConfig(source, "/tmp/config.yml");
    assert.equal(config.custom, undefined);
    assert.equal(hasPromptEdits(config), false);
  }
});

test("replacement action defaults to replace and flags default to global", () => {
  const config = parsePromptConfig(
    [
      "prompt:",
      "  replacements:",
      "    - section: addendum",
      "      pattern: friend",
      "      replacement: companion",
    ].join("\n"),
    "/tmp/pi-friend.yml",
  );

  assert.deepEqual(config.replacements[0], {
    section: "addendum",
    action: "replace",
    pattern: "friend",
    flags: "g",
    replacement: "companion",
  });
});

test("malformed prompt sections fail closed", () => {
  for (const source of [
    "prompt: text\n",
    "prompt:\n  custom: 42\n",
    "prompt:\n  unknown: value\n",
    "prompt:\n  custom:\n    files: persona.md\n",
    "prompt:\n  sections:\n    Preamble: value\n",
    "prompt:\n  sections:\n    addendum: value\n",
    "prompt:\n  replacements: value\n",
    "prompt:\n  replacements:\n    - section: addendum\n",
    "prompt:\n  replacements:\n    - section: addendum\n      action: surround\n      replacement: value\n",
    "prompt:\n  replacements:\n    - section: addendum\n      flags: g\n      replacement: value\n",
    "prompt:\n  replacements:\n    - section: addendum\n      pattern: '['\n      replacement: value\n",
    "prompt:\n  replacements:\n    - section: addendum\n      replacement: value\n      replacement_file: value.md\n",
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
    assert.equal(config.custom?.text, "Configured narrative.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
