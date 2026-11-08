/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoCaptureConfig } from "./config.ts";
import { debugLog, logError } from "../debug/log.ts";
import {
  buildCapturePrompt,
  CaptureResponseError,
  parseCaptureResponse,
  type CaptureCandidateDraft,
  type CaptureSpeakerHint,
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
  speakerHint: CaptureSpeakerHint,
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
  // Kept for the failure path: the text alone cannot say whether a bad reply
  // was truncated, filtered, or came from a different model than configured.
  let finalMessage: AssistantMessage | undefined;
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
    onResponse: (message) => {
      finalMessage = message;
    },
    ...(config.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: config.thinkingLevel }),
  });
  debugLog("capture response", response);
  try {
    return parseCaptureResponse(
      response,
      config.maxCandidates,
      speakerHint,
      reportWarning,
    );
  } catch (error) {
    if (error instanceof CaptureResponseError) {
      // Unconditional, and not deduped: each rejected reply is its own
      // evidence, and the whole point is to see the one that just failed.
      // The text is written to the private log rather than into the thrown
      // message, because that message is shown in a toast.
      logError("capture response rejected", error, {
        dedupeMs: 0,
        detail: {
          model: `${model.provider}/${model.id}`,
          responseModel: finalMessage?.responseModel,
          stopReason: finalMessage?.stopReason,
          rawStopReason: finalMessage?.rawStopReason,
          thinkingLevel:
            finalMessage?.thinkingLevel ??
            finalMessage?.providerThinkingLevel,
          usage: finalMessage?.usage,
          textLength: response.length,
          response,
        },
      });
    }
    throw error;
  }
}
