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
  CAPTURE_REPAIR_SYSTEM_PROMPT,
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

/** One draft the store refused, and the message that says why. */
export interface RejectedDraft {
  draft: CaptureCandidateDraft;
  error: string;
}

/** Rewrites drafts the store refused, given what was wrong with them. */
export type RepairCaptureDrafts = (
  rejected: readonly RejectedDraft[],
) => Promise<readonly CaptureCandidateDraft[]>;

/** What became of one capture pass's drafts. */
export interface StageCaptureResult {
  /** Drafts written to staging, including ones already present verbatim. */
  stored: number;
  /** Drafts still refused after any repair round. */
  rejected: RejectedDraft[];
}

/**
 * Stages a capture pass's drafts, letting one refusal cost one candidate.
 *
 * A pass that stops at the first refusal leaves the earlier drafts staged and the
 * cursor where it was, so the next pass reads the same window again and stages
 * near-duplicates of the ones that worked.
 *
 * Two kinds of failure, two answers. A draft the schema or the service refuses is
 * refused identically on a retry — but its message names the field and the value,
 * which is exactly the feedback a rewrite needs, so `repair` gets one round to try
 * again. Anything else (a write failure, an abort, a full disk) might succeed on a
 * retry, so it propagates and leaves the cursor alone: advancing past a draft that
 * was never judged would lose it silently.
 *
 * One repair round, not a loop. A draft refused twice is a draft that cannot be
 * saved, and the caller reports it while the cursor moves on.
 */
export async function stageCaptureDrafts(
  service: MemoryNodeService,
  drafts: readonly CaptureCandidateDraft[],
  sessionId: string,
  repair?: RepairCaptureDrafts,
): Promise<StageCaptureResult> {
  const first = await stageOneByOne(service, drafts, sessionId);
  if (first.rejected.length === 0 || repair === undefined) {
    return first;
  }

  // Only a draft that still has its content can be repaired. Asking a model to
  // rewrite a candidate whose body is missing would leave it nothing to work
  // from but invention, and a memory that was never said is worse than a memory
  // that was not kept. Capture's parser refuses an empty body before staging, so
  // this is a guard against the class rather than a case anyone has seen.
  const repairable = first.rejected.filter((entry) =>
    hasContentToRepair(entry.draft),
  );
  const unrepairable = first.rejected.filter(
    (entry) => !hasContentToRepair(entry.draft),
  );
  if (repairable.length === 0) {
    return first;
  }

  const repaired = await repair(repairable);
  if (repaired.length === 0) {
    return first;
  }
  const second = await stageOneByOne(service, repaired, sessionId);
  return {
    stored: first.stored + second.stored,
    rejected: [...second.rejected, ...unrepairable],
  };
}

/** Returns whether a refused draft has content a rewrite can reshape. */
function hasContentToRepair(draft: CaptureCandidateDraft): boolean {
  return draft.body.trim() !== "";
}

/** Stages drafts one at a time, collecting refusals rather than stopping. */
async function stageOneByOne(
  service: MemoryNodeService,
  drafts: readonly CaptureCandidateDraft[],
  sessionId: string,
): Promise<StageCaptureResult> {
  let stored = 0;
  const rejected: RejectedDraft[] = [];

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
        draft,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { stored, rejected };
}

/** Returns whether the same draft would be refused again on a retry. */
function isRejectedDraft(error: unknown): boolean {
  return (
    error instanceof MemorySchemaError || error instanceof MemoryServiceError
  );
}

/** Builds the one-round rewrite of drafts the store refused. */
export function createCaptureRepairer(
  ctx: ExtensionContext,
  config: AutoCaptureConfig,
  reportWarning: (message: string) => void,
): RepairCaptureDrafts {
  return async (rejected) => {
    const model = resolveConfiguredModel(
      ctx,
      config.model,
      "auto_capture.model",
      reportWarning,
    );
    if (!model) {
      return [];
    }

    const response = await runNestedModel(ctx, model, {
      systemPrompt: CAPTURE_REPAIR_SYSTEM_PROMPT,
      userContent: buildRepairPrompt(rejected),
      maxTokens: 2_000,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      label: "capture repair",
      reportWarning,
      ...(config.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: config.thinkingLevel }),
    });

    return parseCaptureResponse(
      response,
      rejected.length,
      undefined,
      reportWarning,
    );
  };
}

/**
 * Builds the repair request.
 *
 * The drafts and their rejection messages only: the model is fixing a shape, not
 * reconsidering what was worth remembering, and giving it the transcript again
 * would invite a second, different set of candidates.
 */
export function buildRepairPrompt(rejected: readonly RejectedDraft[]): string {
  return [
    "These memory candidates were rejected by the store. Correct each one.",
    'Use this JSON shape: {"candidates":[{"title":"string","type":"fact|preference|event|person-note","body":"concise Markdown","speaker":[{"name":"string","confident":true,"note":"optional"}],"agents":["string"],"emotional_flavour":"neutral","tags":[],"links":[]}]}',
    'Return {"candidates":[]} for a candidate you cannot correct.',
    "",
    JSON.stringify(
      rejected.map((entry) => ({
        rejection: entry.error,
        candidate: entry.draft,
      })),
      null,
      2,
    ),
  ].join("\n");
}
