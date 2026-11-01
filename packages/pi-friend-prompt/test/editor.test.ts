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

test("custom prompt replacement preserves stock generated sections", () => {
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

test("addendum and custom sections replace their prompt slots", () => {
  const options = normalizedOptions();
  const result = applyPromptConfig(
    options,
    {
      addendum: "Addendum from a file.",
      sections: { house_rules: "House convention." },
      replacements: [],
    },
    buildSections,
  );

  assert.equal(result.changed, true);
  assert.equal(result.narrative, "Addendum from a file.");
  assert.equal(options.appendSystemPrompt, "Addendum from a file.");
  assert.equal(options.sections.house_rules, "House convention.");
});

test("regex replacements support capture groups and global matches", () => {
  const options = normalizedOptions();
  applyPromptConfig(
    options,
    {
      custom: "Lime and Lime.",
      sections: {},
      replacements: [
        {
          section: "preamble",
          action: "replace",
          pattern: "(Lime)",
          flags: "g",
          replacementText: "[$1]",
        },
      ],
    },
    buildSections,
  );

  assert.equal(options.customPrompt, "[Lime] and [Lime].");
  assert.equal(options.sections.tools, "stock tools");
});

test("whole-section appends preserve the existing text", () => {
  const options = normalizedOptions();
  options.appendSystemPrompt = "Original addendum.";
  applyPromptConfig(
    options,
    {
      sections: {},
      replacements: [
        {
          section: "addendum",
          action: "append",
          flags: "",
          replacementText: "\nAppended text.",
        },
      ],
    },
    buildSections,
  );

  assert.equal(
    options.appendSystemPrompt,
    "Original addendum.\nAppended text.",
  );
});

test("regex prepend and append operate around each match", () => {
  const options = normalizedOptions();
  options.customPrompt = "Alpha Beta.";
  applyPromptConfig(
    options,
    {
      sections: {},
      replacements: [
        {
          section: "preamble",
          action: "prepend",
          pattern: "Beta",
          flags: "g",
          replacementText: "Before ",
        },
        {
          section: "preamble",
          action: "append",
          pattern: "Alpha",
          flags: "g",
          replacementText: " After",
        },
      ],
    },
    buildSections,
  );

  assert.equal(options.customPrompt, "Alpha After Before Beta.");
});

test("a failed replacement leaves the original options unchanged", () => {
  const options = normalizedOptions();
  const before = JSON.parse(JSON.stringify(options)) as unknown;
  const config: ResolvedPromptConfig = {
    sections: {},
    replacements: [
      {
        section: "missing_section",
        action: "append",
        flags: "",
        replacementText: "Never applied.",
      },
    ],
  };

  assert.throws(
    () => applyPromptConfig(options, config, buildSections),
    /does not exist/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(options)) as unknown, before);
});

/** Builds a complete normalized options fixture. */
function normalizedOptions(): NormalizedBuildSystemPromptOptions {
  return {
    customPrompt: "Old prompt",
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
