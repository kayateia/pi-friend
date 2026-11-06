/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoCaptureConfig } from "./config.ts";
import { debugLog } from "../debug/log.ts";
import {
  buildCapturePrompt,
  inferSpeakerName,
  parseCaptureResponse,
  type CaptureCandidateDraft,
} from "./capture.ts";
import {
  CAPTURE_SYSTEM_PROMPT,
  resolveSystemPrompt,
} from "./prompts.ts";
import { resolveConfiguredModel, runNestedModel } from "./model-call.ts";

const CAPTURE_TIMEOUT_MS = 30_000;

/**
 * Runs one isolated capture-model request over the supplied transcript.
 *
 * The nested request receives no tools and is bounded by a timeout so
 * background capture cannot hang session settlement indefinitely.
 */
export async function runCaptureModel(
  ctx: ExtensionContext,
  config: AutoCaptureConfig,
  transcript: string,
  reportWarning: (message: string) => void,
): Promise<CaptureCandidateDraft[]> {
  const model = resolveConfiguredModel(
    ctx,
    config.model,
    "auto_capture.model",
    reportWarning,
  );
  if (!model) {
    throw new Error("No model is available for auto-capture.");
  }

  const signal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
  const speakerHint = inferSpeakerName(transcript);
  const response = await runNestedModel(ctx, model, {
    systemPrompt: resolveSystemPrompt(CAPTURE_SYSTEM_PROMPT, config),
    userContent: buildCapturePrompt(
      transcript,
      config.maxCandidates,
      speakerHint,
    ),
    maxTokens: 2_000,
    timeoutMs: CAPTURE_TIMEOUT_MS,
    label: "auto-capture",
    reportWarning,
    signal,
    ...(config.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: config.thinkingLevel }),
  });
  debugLog("capture response", response);
  return parseCaptureResponse(response, config.maxCandidates, speakerHint);
}
