/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePromptConfig, PromptConfigError } from "../src/config.ts";
import { resolvePromptConfig } from "../src/prompt-files.ts";

test("prompt files resolve in declared order relative to the config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    await writeFile(path.join(directory, "first.md"), "First file.\n", "utf8");
    await writeFile(path.join(directory, "second.md"), "Second file.\n", "utf8");
    const config = parsePromptConfig(
      [
        "prompt:",
        "  custom:",
        "    text: Inline text.",
        "    files: [first.md, second.md]",
        "  addendum:",
        "    files: [first.md]",
        "  sections:",
        "    project_context:",
        "      files: [second.md]",
        "  replacements:",
        "    - section: addendum",
        "      action: append",
        "      replacement_file: first.md",
      ].join("\n"),
      path.join(directory, "pi-friend.yml"),
    );

    const resolved = await resolvePromptConfig(config);

    assert.equal(
      resolved.custom,
      "Inline text.\n\nFirst file.\n\nSecond file.",
    );
    assert.equal(resolved.addendum, "First file.");
    assert.equal(resolved.sections.project_context, "Second file.");
    assert.equal(resolved.replacements[0]?.replacementText, "First file.\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt files are reread for every request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    const promptPath = path.join(directory, "persona.md");
    await writeFile(promptPath, "First version.", "utf8");
    const config = parsePromptConfig(
      "prompt:\n  custom:\n    files: [persona.md]\n",
      path.join(directory, "pi-friend.yml"),
    );

    assert.equal((await resolvePromptConfig(config)).custom, "First version.");

    await writeFile(promptPath, "Second version.", "utf8");
    assert.equal((await resolvePromptConfig(config)).custom, "Second version.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing prompt files produce a contextual error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    const configPath = path.join(directory, "pi-friend.yml");
    const config = parsePromptConfig(
      "prompt:\n  addendum:\n    files: [missing.md]\n",
      configPath,
    );

    await assert.rejects(
      resolvePromptConfig(config),
      (error: unknown) =>
        error instanceof PromptConfigError &&
        error.message.includes("prompt.addendum.files[0]") &&
        error.message.includes(path.join(directory, "missing.md")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the packaged prompt example parses and resolves", async () => {
  const examplePath = fileURLToPath(
    new URL("../pi-friend-prompt.example.yml", import.meta.url),
  );
  const config = parsePromptConfig(
    await readFile(examplePath, "utf8"),
    examplePath,
  );
  const resolved = await resolvePromptConfig(config);

  assert.match(resolved.custom ?? "", /You are Lime/);
  assert.match(resolved.addendum ?? "", /direct, warm, concrete/);
  assert.equal(resolved.replacements[0]?.action, "prepend");
  assert.equal(resolved.replacements[1]?.action, "append");
});
