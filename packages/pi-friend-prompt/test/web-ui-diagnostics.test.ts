/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  analyzePromptDelivery,
  readWebUiPromptSettings,
} from "../src/web-ui-diagnostics.ts";

test("web UI diagnostics report prompt composer settings", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-diagnostics-"));
  try {
    await writeFile(
      path.join(dataDir, "client-state.json"),
      JSON.stringify({
        __settings__: {
          settings: {
            promptTemplate: "custom {{skills}}",
            promptOverrides: { soul: "Lime", empty: "  " },
            defaultAgentPreset: "code",
            disabledAgentTools: ["bash", "terminal"],
            toolLazyLoading: true,
          },
        },
      }),
      "utf8",
    );

    const settings = readWebUiPromptSettings({
      PI_WEB_DATA_DIR: dataDir,
    });
    assert.equal(settings.available, true);
    assert.equal(settings.promptTemplateActive, true);
    assert.deepEqual(settings.promptOverrideSources, ["soul"]);
    assert.equal(settings.agentPreset, "code");
    assert.equal(settings.nonStandardPreset, true);
    assert.equal(settings.disabledToolCount, 2);
    assert.equal(settings.lazyToolLoading, true);
    assert.equal(settings.composerReplacesSystemPrompt, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing web UI state is reported without throwing", () => {
  const settings = readWebUiPromptSettings({
    PI_WEB_DATA_DIR: path.join(tmpdir(), "missing-pi-web-state"),
  });
  assert.equal(settings.available, false);
  assert.equal(settings.composerReplacesSystemPrompt, false);
});

test("delivery diagnostics identify a later prompt override", () => {
  const webUi = readWebUiPromptSettings({
    PI_WEB_DATA_DIR: path.join(tmpdir(), "missing-pi-web-state"),
  });
  const diagnostic = analyzePromptDelivery(
    "stock prompt without the narrative",
    "You are Lime.",
    "stock prompt without the narrative",
    { ...webUi, composerReplacesSystemPrompt: true },
  );

  assert.equal(diagnostic.narrativePresentInFinalPrompt, false);
  assert.equal(diagnostic.forceSystemPrompt.present, true);
  assert.equal(
    diagnostic.forceSystemPrompt.includesConfiguredNarrative,
    false,
  );
  assert.equal(diagnostic.overriddenByLaterHandler, true);
  assert.equal(diagnostic.likelyWebUiOverride, true);
});
