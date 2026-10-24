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
import { applyCustomPrompt } from "../src/editor.ts";

test("custom prompt replacement preserves stock generated sections", () => {
  const options = normalizedOptions();
  const calledWith: BuildSystemPromptOptions[] = [];
  const applied = applyCustomPrompt(options, "You are Lime.", (input) => {
    calledWith.push(input);
    return {
      preamble: "stock",
      tools: "<tools>stock tools</tools>",
      rules: "<rules>stock rules</rules>",
      docs: "<docs>stock docs</docs>",
      cwd: "<cwd>/tmp</cwd>",
    };
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
  const applied = applyCustomPrompt(options, "   ", () => ({}));

  assert.equal(applied, false);
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
