/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyCustomPrompt, applyPromptConfig } from "../src/editor.ts";
import { loadSystemPromptApi } from "../src/system-prompt-compat.ts";

test("actual Pi prompt builder retains tools, rules, and docs", async () => {
  const api = await loadSystemPromptApi();
  const options = api.normalizeBuildSystemPromptOptions({
    cwd: "/tmp",
    selectedTools: ["read"],
    toolSnippets: { read: "Read files" },
  });

  applyCustomPrompt(options, "You are a configured friend.", api.buildSystemPromptSections);
  const sections = api.buildSystemPromptSections(options);

  assert.equal(sections.preamble, "You are a configured friend.");
  assert.match(sections.tools ?? "", /Read files/);
  assert.match(sections.rules ?? "", /Be concise/);
  assert.match(sections.docs ?? "", /Pi documentation/);
});

test("actual Pi prompt builder applies addendum and section rewrites", async () => {
  const api = await loadSystemPromptApi();
  const options = api.normalizeBuildSystemPromptOptions({
    cwd: "/tmp",
    selectedTools: ["read"],
    toolSnippets: { read: "Read files" },
    appendSystemPrompt: "Original addendum.",
  });

  applyPromptConfig(
    options,
    {
      changes: [
        {
          section: "addendum",
          action: "replace",
          flags: "",
          files: [],
          sourceText: "Configured addendum.",
        },
        {
          section: "house_rules",
          action: "replace",
          flags: "",
          files: [],
          sourceText: "House rules.",
        },
        {
          section: "addendum",
          action: "append",
          flags: "",
          files: [],
          sourceText: "Extra addendum.",
        },
        {
          section: "rules",
          action: "replace",
          pattern: "^- Be concise.*$",
          flags: "gm",
          files: [],
          sourceText: "- Stay concise",
        },
      ],
    },
    api.buildSystemPromptSections,
  );
  const sections = api.buildSystemPromptSections(options);

  assert.match(sections.addendum ?? "", /Configured addendum\./);
  assert.match(sections.addendum ?? "", /Extra addendum\./);
  assert.doesNotMatch(sections.addendum ?? "", /Original addendum\./);
  assert.match(sections.house_rules ?? "", /House rules\./);
  assert.match(sections.rules ?? "", /Stay concise/);
  assert.doesNotMatch(sections.rules ?? "", /- Be concise/);
});
