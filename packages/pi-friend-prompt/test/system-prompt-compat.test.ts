/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyCustomPrompt } from "../src/editor.ts";
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
