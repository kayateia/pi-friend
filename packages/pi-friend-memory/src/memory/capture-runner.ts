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
import { debugLog } from "../debug/log.ts";
import {
  buildCapturePrompt,
  CAPTURE_SYSTEM_PROMPT,
  inferSpeakerName,
  parseCaptureResponse,
  type CaptureCandidateDraft,
} from "./capture.ts";

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
  const model = resolveCaptureModel(ctx, config.model, reportWarning);
  if (!model) {
    throw new Error("No model is available for auto-capture.");
  }

  const signal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
  const speakerHint = inferSpeakerName(transcript);
  const stream = ctx.modelRegistry.streamSimple(
    model,
    {
      systemPrompt: config.prompt ?? CAPTURE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildCapturePrompt(
            transcript,
            config.maxCandidates,
            speakerHint,
          ),
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal,
      maxTokens: 2_000,
    },
  );

  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      finalMessage = event.message;
    } else if (event.type === "error") {
      throw new Error(
        event.error.errorMessage ?? "Capture model request failed.",
      );
    }
  }
  if (!finalMessage) {
    throw new Error("Capture model returned no final message.");
  }

  const response = finalMessage.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  debugLog("capture response", response);
  return parseCaptureResponse(response, config.maxCandidates, speakerHint);
}

/** Resolves the configured fast model or falls back to the session model. */
function resolveCaptureModel(
  ctx: ExtensionContext,
  configuredModel: string | undefined,
  reportWarning: (message: string) => void,
): ExtensionContext["model"] {
  if (!configuredModel) {
    return ctx.model;
  }

  const slash = configuredModel.indexOf("/");
  if (slash <= 0 || slash === configuredModel.length - 1) {
    reportWarning(
      `pi-friend auto_capture.model "${configuredModel}" must use provider/model-id; using the session model.`,
    );
    return ctx.model;
  }

  const provider = configuredModel.slice(0, slash);
  const modelId = configuredModel.slice(slash + 1);
  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    reportWarning(
      `pi-friend auto_capture.model "${configuredModel}" was not found; using the session model.`,
    );
    return ctx.model;
  }
  return found;
}
