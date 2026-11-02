/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import type {
  BuildSystemPromptOptions,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { applyCustomPrompt, applyPromptConfig } from "../src/editor.ts";
import type { ResolvedPromptConfig } from "../src/prompt-files.ts";

test("preamble replacement preserves stock generated sections", () => {
  const options = normalizedOptions();
  const calledWith: BuildSystemPromptOptions[] = [];
  const applied = applyCustomPrompt(options, "You are Lime.", (input) => {
    calledWith.push(input);
    return buildSections(input);
  });

  assert.equal(applied, true);
  assert.equal(calledWith[0]?.customPrompt, undefined);
  assert.equal(options.customPrompt, "You are Lime.");
  assert.equal(options.sections.tools, "stock tools");
  assert.equal(options.sections.rules, "stock rules");
  assert.equal(options.sections.docs, "stock docs");
  assert.equal(options.sections.existing, "keep");
});

test("empty custom prompt leaves options unchanged", () => {
  const options = normalizedOptions();
  const before = JSON.parse(JSON.stringify(options)) as unknown;
  const applied = applyCustomPrompt(options, "   ", buildSections);

  assert.equal(applied, false);
  assert.deepEqual(JSON.parse(JSON.stringify(options)) as unknown, before);
});

test("repeated section changes apply in configuration order", () => {
  const options = normalizedOptions();
  const result = applyPromptConfig(
    options,
    {
      changes: [
        {
          section: "house_rules",
          action: "replace",
          files: [],
          sourceText: "First rule.",
          flags: "",
        },
        {
          section: "house_rules",
          action: "append",
          files: [],
          sourceText: "Second rule.",
          flags: "",
        },
        {
          section: "house_rules",
          action: "append",
          pattern: "^First rule\\.",
          flags: "gm",
          files: [],
          sourceText: " Start here.",
        },
      ],
    },
    buildSections,
  );

  assert.equal(result.changed, true);
  assert.equal(
    options.sections.house_rules,
    "First rule. Start here.\n\nSecond rule.",
  );
});

test("addendum prepend and append use the existing addendum", () => {
  const options = normalizedOptions();
  options.appendSystemPrompt = "Original addendum.";
  const result = applyPromptConfig(
    options,
    {
      changes: [
        {
          section: "addendum",
          action: "prepend",
          files: [],
          sourceText: "Before.",
          flags: "",
        },
        {
          section: "addendum",
          action: "append",
          files: [],
          sourceText: "After.",
          flags: "",
        },
      ],
    },
    buildSections,
  );

  assert.equal(result.narrative, "Before.\n\nOriginal addendum.\n\nAfter.");
  assert.equal(
    options.appendSystemPrompt,
    "Before.\n\nOriginal addendum.\n\nAfter.",
  );
});

test("regex replacements support capture groups and global matches", () => {
  const options = normalizedOptions();
  options.customPrompt = "Lime and Lime.";
  applyPromptConfig(
    options,
    {
      changes: [
        {
          section: "preamble",
          action: "replace",
          pattern: "(Lime)",
          flags: "g",
          files: [],
          sourceText: "[$1]",
        },
      ],
    },
    buildSections,
  );

  assert.equal(options.customPrompt, "[Lime] and [Lime].");
  assert.equal(options.sections.tools, "stock tools");
});

test("a missing custom section must be created before it can be appended", () => {
  const options = normalizedOptions();
  const before = JSON.parse(JSON.stringify(options)) as unknown;
  const config: ResolvedPromptConfig = {
    changes: [
      {
        section: "preamble",
        action: "replace",
        files: [],
        sourceText: "This would succeed on its own.",
        flags: "",
      },
      {
        section: "missing_section",
        action: "append",
        files: [],
        sourceText: "Never applied.",
        flags: "",
      },
    ],
  };

  assert.throws(
    () => applyPromptConfig(options, config, buildSections),
    /Use a whole-section replace first/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(options)) as unknown, before);
});

/** Builds a complete normalized options fixture. */
function normalizedOptions(): NormalizedBuildSystemPromptOptions {
  return {
    customPrompt: "Old prompt.",
    forceSystemPrompt: undefined,
    selectedTools: ["read"],
    hiddenTools: [],
    toolSnippets: { read: "Read files" },
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: { existing: "keep" },
    cwd: "/tmp",
    contextFiles: [],
    skills: [],
  };
}

/** Minimal section builder that mirrors Pi's wrapper behavior. */
function buildSections(
  input: BuildSystemPromptOptions,
): Record<string, string> {
  const sections: Record<string, string> = {
    preamble: input.customPrompt ?? "Stock preamble.",
    cwd: "<cwd>\n/tmp\n</cwd>",
  };
  if (!input.customPrompt) {
    sections.tools = "<tools>\nstock tools\n</tools>";
    sections.rules = "<rules>\nstock rules\n</rules>";
    sections.docs = "<docs>\nstock docs\n</docs>";
  }
  if (input.appendSystemPrompt) {
    sections.addendum = `<addendum>\n${input.appendSystemPrompt}\n</addendum>`;
  }
  for (const [name, content] of Object.entries(input.sections ?? {})) {
    if (name !== "preamble" && content) {
      sections[name] = `<${name}>\n${content}\n</${name}>`;
    }
  }
  return sections;
}
