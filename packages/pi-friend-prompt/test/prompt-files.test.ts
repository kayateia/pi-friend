/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePromptConfig } from "../src/config.ts";
import { resolvePromptConfig } from "../src/prompt-files.ts";

test("prompt files resolve in declared order relative to the config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    await writeFile(path.join(directory, "first.md"), "First file.\n", "utf8");
    await writeFile(path.join(directory, "second.md"), "Second file.\n", "utf8");
    const config = parsePromptConfig(
      [
        "prompt:",
        "  - section: preamble",
        "    action: replace",
        "    text: Inline text.",
        "    files: [first.md, second.md]",
        "  - section: addendum",
        "    action: append",
        "    files: [first.md]",
      ].join("\n"),
      path.join(directory, "pi-friend-prompt.yml"),
    );

    const resolved = await resolvePromptConfig(config);

    assert.equal(
      resolved.changes[0]?.sourceText,
      "Inline text.\n\nFirst file.\n\nSecond file.",
    );
    assert.equal(resolved.changes[1]?.sourceText, "First file.");
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
      [
        "prompt:",
        "  - section: preamble",
        "    action: replace",
        "    files: [persona.md]",
      ].join("\n"),
      path.join(directory, "pi-friend-prompt.yml"),
    );

    assert.equal(
      (await resolvePromptConfig(config)).changes[0]?.sourceText,
      "First version.",
    );

    await writeFile(promptPath, "Second version.", "utf8");
    assert.equal(
      (await resolvePromptConfig(config)).changes[0]?.sourceText,
      "Second version.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing prompt file warns and is skipped while readable sources still apply", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    await writeFile(path.join(directory, "present.md"), "Present file.\n", "utf8");
    const configPath = path.join(directory, "pi-friend-prompt.yml");
    const config = parsePromptConfig(
      [
        "prompt:",
        "  - section: addendum",
        "    action: replace",
        "    text: Inline text.",
        "    files: [missing.md, present.md]",
      ].join("\n"),
      configPath,
    );

    const resolved = await resolvePromptConfig(config);

    assert.equal(resolved.changes.length, 1);
    assert.equal(resolved.changes[0]?.sourceText, "Inline text.\n\nPresent file.");
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0] ?? "", /prompt\[0\]\.files\[0\]/);
    assert.match(
      resolved.warnings[0] ?? "",
      new RegExp(path.join(directory, "missing\.md")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a change whose only file is missing is skipped and reported", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    const configPath = path.join(directory, "pi-friend-prompt.yml");
    const config = parsePromptConfig(
      [
        "prompt:",
        "  - section: addendum",
        "    action: replace",
        "    files: [missing.md]",
        "  - section: house_rules",
        "    action: replace",
        "    text: Be kind.",
      ].join("\n"),
      configPath,
    );

    const resolved = await resolvePromptConfig(config);

    assert.equal(resolved.changes.length, 1);
    assert.equal(resolved.changes[0]?.section, "house_rules");
    assert.equal(resolved.warnings.length, 2);
    assert.match(resolved.warnings[0] ?? "", /does not exist/);
    assert.match(resolved.warnings[1] ?? "", /prompt\[0\].*was skipped/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable file that is not missing also warns instead of failing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-files-"));
  try {
    // A directory in place of a file produces EISDIR on Linux and macOS alike,
    // so this covers read failures other than a plain missing file.
    await mkdir(path.join(directory, "not-a-file.md"));
    const configPath = path.join(directory, "pi-friend-prompt.yml");
    const config = parsePromptConfig(
      [
        "prompt:",
        "  - section: addendum",
        "    action: replace",
        "    text: Still applied.",
        "    files: [not-a-file.md]",
      ].join("\n"),
      configPath,
    );

    const resolved = await resolvePromptConfig(config);

    assert.equal(resolved.changes[0]?.sourceText, "Still applied.");
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0] ?? "", /could not be read \(EISDIR\)/);
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

  assert.ok(resolved.changes.length >= 5);
  assert.equal(resolved.changes[0]?.section, "preamble");
  assert.equal(resolved.changes[0]?.action, "replace");
  assert.match(resolved.changes[0]?.sourceText ?? "", /You are Lime/);
});
