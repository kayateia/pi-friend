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
import {
  applyCustomPrompt,
  createPromptFallbackMessage,
  injectPromptFallback,
} from "../src/editor.ts";

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

test("prompt fallback is non-displayed and namespaced", () => {
  const message = createPromptFallbackMessage("You are Lime.", 123);
  assert.deepEqual(message, {
    role: "custom",
    customType: "pi-friend-prompt",
    content: "<pi-friend-prompt>\nYou are Lime.\n</pi-friend-prompt>",
    display: false,
    timestamp: 123,
  });
});

test("prompt fallback stays behind the leading system message", () => {
  const messages = [
    { role: "system" as const, content: "system", timestamp: 1 },
    { role: "user" as const, content: "hello", timestamp: 2 },
  ];
  const injected = injectPromptFallback(messages, "You are Lime.", 3);

  assert.equal(injected[0], messages[0]);
  assert.equal(injected[1]?.role, "custom");
  assert.equal(injected[2], messages[1]);
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
