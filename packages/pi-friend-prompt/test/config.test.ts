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
  getPromptConfigPath,
  hasPromptEdits,
  loadPromptConfig,
  parsePromptConfig,
  PromptConfigError,
} from "../src/config.ts";

test("prompt config parses an ordered list with repeated sections", () => {
  const config = parsePromptConfig(
    [
      "memory:",
      "  root: ~/memory",
      "prompt:",
      "  - section: preamble",
      "    action: replace",
      "    text: Configured narrative.",
      "    files:",
      "      - persona/core.md",
      "      - persona/local.md",
      "  - section: addendum",
      "    action: prepend",
      "    files: [addendum.md]",
      "  - section: addendum",
      "    action: append",
      "    text: Extra addendum.",
      "  - section: rules",
      "    action: replace",
      "    pattern: '^- Be concise.*$'",
      "    flags: gm",
      "    text: '- Stay focused'",
    ].join("\n"),
    "/tmp/pi-friend-prompt.yml",
  );

  assert.deepEqual(config.changes, [
    {
      section: "preamble",
      action: "replace",
      text: "Configured narrative.",
      files: ["persona/core.md", "persona/local.md"],
      flags: "",
    },
    {
      section: "addendum",
      action: "prepend",
      files: ["addendum.md"],
      flags: "",
    },
    {
      section: "addendum",
      action: "append",
      text: "Extra addendum.",
      files: [],
      flags: "",
    },
    {
      section: "rules",
      action: "replace",
      pattern: "^- Be concise.*$",
      flags: "gm",
      text: "- Stay focused",
      files: [],
    },
  ]);
  assert.equal(hasPromptEdits(config), true);
});

test("missing and empty prompt lists are no-ops", () => {
  for (const source of [
    "memory:\n  root: ~/memory\n",
    "prompt: []\n",
  ]) {
    const config = parsePromptConfig(source, "/tmp/config.yml");
    assert.deepEqual(config.changes, []);
    assert.equal(hasPromptEdits(config), false);
  }
});

test("regex flags default to global", () => {
  const config = parsePromptConfig(
    [
      "prompt:",
      "  - section: addendum",
      "    action: replace",
      "    pattern: friend",
      "    text: companion",
    ].join("\n"),
    "/tmp/pi-friend-prompt.yml",
  );

  assert.deepEqual(config.changes[0], {
    section: "addendum",
    action: "replace",
    pattern: "friend",
    flags: "g",
    text: "companion",
    files: [],
  });
});

test("malformed prompt changes fail closed", () => {
  for (const source of [
    "prompt: text\n",
    "prompt:\n  custom: old form\n",
    "prompt:\n  - section: preamble\n    action: replace\n",
    "prompt:\n  - section: Preamble\n    action: replace\n    text: value\n",
    "prompt:\n  - section: preamble\n    text: value\n",
    "prompt:\n  - section: preamble\n    action: substitution\n    text: value\n",
    "prompt:\n  - section: preamble\n    action: replace\n    from: value\n    text: value\n",
    "prompt:\n  - section: preamble\n    action: replace\n    files: persona.md\n",
    "prompt:\n  - section: preamble\n    action: replace\n    files: []\n",
    "prompt:\n  - section: preamble\n    action: replace\n    flags: g\n    text: value\n",
    "prompt:\n  - section: preamble\n    action: replace\n    pattern: '['\n    text: value\n",
  ]) {
    assert.throws(
      () => parsePromptConfig(source, "/tmp/config.yml"),
      PromptConfigError,
    );
  }
});

test("prompt config loads from the dedicated Pi agent path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-config-"));
  try {
    const configPath = getPromptConfigPath(directory);
    assert.equal(
      configPath,
      path.join(directory, "pi-friend", "pi-friend-prompt.yml"),
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        "prompt:",
        "  - section: preamble",
        "    action: replace",
        "    text: Configured narrative.",
      ].join("\n"),
      "utf8",
    );

    const config = await loadPromptConfig({ agentDir: directory });
    assert.equal(config.changes[0]?.text, "Configured narrative.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt config ignores prompt data in the shared pi-friend file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-config-"));
  try {
    const sharedDirectory = path.join(directory, "pi-friend");
    await mkdir(sharedDirectory, { recursive: true });
    await writeFile(
      path.join(sharedDirectory, "pi-friend.yml"),
      [
        "prompt:",
        "  - section: preamble",
        "    action: replace",
        "    text: Old shared prompt.",
      ].join("\n"),
      "utf8",
    );

    const config = await loadPromptConfig({ agentDir: directory });
    assert.deepEqual(config.changes, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
