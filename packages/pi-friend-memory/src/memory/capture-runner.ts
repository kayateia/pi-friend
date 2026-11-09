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
import { MemorySchemaError } from "./schema.ts";
import {
  MemoryServiceError,
  type MemoryNodeService,
} from "./service.ts";

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

/** What became of one capture pass's drafts. */
export interface StageCaptureResult {
  /** Drafts written to staging, including ones already present verbatim. */
  stored: number;
  /** Drafts the store refused, and why. */
  rejected: Array<{ title: string; error: string }>;
}

/**
 * Stages a capture pass's drafts, letting one rejection cost one candidate.
 *
 * A pass that stops at the first refusal leaves the earlier drafts staged and the
 * cursor where it was, so the next pass reads the same window again and stages
 * near-duplicates of the ones that worked. Two kinds of failure, two answers:
 *
 * - A draft the schema or the service refuses is refused identically next time.
 *   Skipping it and finishing the pass lets the cursor advance, which is what
 *   stops the window being re-read; the candidate is reported instead of stored.
 * - Anything else — a write failure, an abort, a full disk — might succeed on a
 *   retry, so it propagates and leaves the cursor alone. Advancing past a draft
 *   that was never really rejected would lose it.
 */
export async function stageCaptureDrafts(
  service: MemoryNodeService,
  drafts: readonly CaptureCandidateDraft[],
  sessionId: string,
  reportWarning: (message: string) => void,
): Promise<StageCaptureResult> {
  let stored = 0;
  const rejected: Array<{ title: string; error: string }> = [];

  for (const draft of drafts) {
    try {
      await service.stageCandidate({
        title: draft.title,
        type: draft.type,
        body: draft.body,
        speaker: draft.speaker,
        agents: draft.agents,
        emotionalFlavour: draft.emotionalFlavour,
        tags: draft.tags,
        links: draft.links,
        source: draft.source ?? `session:${sessionId}`,
      });
      stored += 1;
    } catch (error) {
      if (!isRejectedDraft(error)) {
        throw error;
      }
      rejected.push({
        title: draft.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (rejected.length > 0) {
    reportWarning(
      `pi-friend auto-capture: could not store ${rejected.length} of ${drafts.length} candidates, and skipped them so the same window is not read again: ${rejected
        .map((entry) => `${entry.title} (${entry.error})`)
        .join("; ")}.`,
    );
  }

  return { stored, rejected };
}

/** Returns whether the same draft would be refused again on a retry. */
function isRejectedDraft(error: unknown): boolean {
  return error instanceof MemorySchemaError || error instanceof MemoryServiceError;
}
