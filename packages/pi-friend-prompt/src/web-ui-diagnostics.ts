/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** Relevant pi-web-ui prompt-composer settings. */
export interface WebUiPromptSettings {
  available: boolean;
  settingsPath: string;
  promptTemplateActive: boolean;
  promptOverrideSources: string[];
  agentPreset: string;
  nonStandardPreset: boolean;
  disabledToolCount: number;
  lazyToolLoading: boolean;
  composerReplacesSystemPrompt: boolean;
}

/** Prompt-delivery facts captured after all before_agent_start handlers. */
export interface PromptDeliveryDiagnostic {
  finalSystemPromptChars: number;
  configuredNarrativeChars: number;
  narrativePresentInFinalPrompt: boolean;
  forceSystemPrompt: {
    present: boolean;
    chars?: number;
    includesConfiguredNarrative?: boolean;
  };
  overriddenByLaterHandler: boolean;
  likelyWebUiOverride: boolean;
}

/** Compares our configured narrative with the final forced prompt. */
export function analyzePromptDelivery(
  finalPrompt: string,
  narrative: string | undefined,
  forcedPrompt: string | undefined,
  webUi: WebUiPromptSettings,
): PromptDeliveryDiagnostic {
  const narrativePresent =
    narrative === undefined || finalPrompt.includes(narrative);
  const forcedPromptIncludesNarrative =
    narrative === undefined ||
    (typeof forcedPrompt === "string" && forcedPrompt.includes(narrative));

  return {
    finalSystemPromptChars: finalPrompt.length,
    configuredNarrativeChars: narrative?.length ?? 0,
    narrativePresentInFinalPrompt: narrativePresent,
    forceSystemPrompt:
      typeof forcedPrompt === "string"
        ? {
            present: true,
            chars: forcedPrompt.length,
            includesConfiguredNarrative:
              forcedPromptIncludesNarrative,
          }
        : { present: false },
    overriddenByLaterHandler:
      narrative !== undefined && !narrativePresent,
    likelyWebUiOverride:
      webUi.composerReplacesSystemPrompt && !narrativePresent,
  };
}

/**
 * Reads the persisted pi-web-ui settings used by its final prompt handler.
 *
 * The file is optional and may not exist when pi-web-ui is not in use. Parse
 * and filesystem failures degrade to `available: false` rather than affecting
 * prompt generation.
 */
export function readWebUiPromptSettings(
  env: NodeJS.ProcessEnv = process.env,
): WebUiPromptSettings {
  const dataDir =
    env.PI_WEB_DATA_DIR?.trim() || path.join(homedir(), ".pi-web");
  const settingsPath = path.join(dataDir, "client-state.json");
  const unavailable = (): WebUiPromptSettings => ({
    available: false,
    settingsPath,
    promptTemplateActive: false,
    promptOverrideSources: [],
    agentPreset: "unknown",
    nonStandardPreset: false,
    disabledToolCount: 0,
    lazyToolLoading: false,
    composerReplacesSystemPrompt: false,
  });

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return unavailable();
  }
  if (!isRecord(document) || !isRecord(document.__settings__)) {
    return unavailable();
  }
  const settings = document.__settings__.settings;
  if (!isRecord(settings)) {
    return unavailable();
  }

  const promptTemplateActive =
    typeof settings.promptTemplate === "string" &&
    settings.promptTemplate.trim() !== "";
  const promptOverrideSources = isRecord(settings.promptOverrides)
    ? Object.entries(settings.promptOverrides)
        .filter(
          ([, value]) =>
            typeof value === "string" && value.trim() !== "",
        )
        .map(([name]) => name)
        .sort()
    : [];
  const agentPreset =
    typeof settings.defaultAgentPreset === "string" &&
    settings.defaultAgentPreset.trim() !== ""
      ? settings.defaultAgentPreset
      : "standard";
  const nonStandardPreset = agentPreset !== "standard";
  const disabledToolCount = Array.isArray(settings.disabledAgentTools)
    ? settings.disabledAgentTools.filter(
        (value): value is string => typeof value === "string",
      ).length
    : 0;
  const lazyToolLoading =
    typeof settings.toolLazyLoading === "boolean"
      ? settings.toolLazyLoading
      : envFlag(env.PI_WEB_TOOL_LAZY_LOADING);

  return {
    available: true,
    settingsPath,
    promptTemplateActive,
    promptOverrideSources,
    agentPreset,
    nonStandardPreset,
    disabledToolCount,
    lazyToolLoading,
    composerReplacesSystemPrompt:
      promptTemplateActive ||
      promptOverrideSources.length > 0 ||
      nonStandardPreset ||
      disabledToolCount > 0 ||
      lazyToolLoading,
  };
}

/** Parses pi-web-ui's deployment-level lazy-loading flag. */
function envFlag(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
