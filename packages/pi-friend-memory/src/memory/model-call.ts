/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugLog, logError } from "../debug/log.ts";
import { reportOnce } from "./report.ts";

/** One nested model request: a system prompt, one user message, and a cap. */
export interface NestedCallOptions {
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Thinking level to request. Providers differ in which levels they accept and
   * how they map them; a rejected level is retried once without it rather than
   * failing the pass.
   */
  thinkingLevel?: ThinkingLevel;
  /** Name of the pass, used in the warning when a retry happens. */
  label?: string;
  /** Where a retry is announced; the file log gets it either way. */
  reportWarning?: (message: string) => void;
  /**
   * Called with the final assistant message before its text is extracted.
   *
   * The text alone cannot explain a bad reply: `stopReason`, the model that
   * actually answered (`responseModel`), and the token usage are what say
   * whether a truncated or empty answer was a budget problem, a routing
   * surprise, or the model simply refusing. Only passes that diagnose their
   * own output need this, so it stays optional.
   */
  onResponse?: (message: AssistantMessage) => void;
}

/**
 * Runs one nested model call and returns its text.
 *
 * Every internal pass — capture, sweep, dream, merge — goes through here so the
 * retry rule and the text extraction exist once. The retry is deliberately
 * narrow: it fires only when the call with a thinking level errors, and the
 * second attempt omits the level so the provider picks its own default.
 */
export async function runNestedModel(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
  options: NestedCallOptions,
): Promise<string> {
  if (options.thinkingLevel === undefined) {
    return request(ctx, model, options, undefined);
  }
  try {
    return await request(ctx, model, options, options.thinkingLevel);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    // The model catalogue is maintained by hand, so it can be wrong about which
    // levels a provider accepts, and a provider can reject a level it claims to
    // support. Neither is worth abandoning a pass that has already done work, so
    // the level is dropped and the call retried once. The retry is announced
    // once per model and level, because a level that never works is a
    // configuration mistake someone needs to see, and a banner on every sweep
    // would be noise rather than a signal.
    const detail = error instanceof Error ? error.message : String(error);
    const label = options.label ?? "model call";
    const key = `thinking-level:${model.provider}/${model.id}:${options.thinkingLevel}`;
    logError(
      `${label} rejected thinking level ${options.thinkingLevel}`,
      new Error(`${model.provider}/${model.id}: ${detail}`),
    );
    reportOnce(
      key,
      options.reportWarning,
      `pi-friend: the ${label} model "${model.provider}/${model.id}" rejected thinking level "${options.thinkingLevel}" (${detail}); retrying without it. Check the configured thinking_level.`,
    );
    debugLog("nested call retry without thinking level", {
      thinkingLevel: options.thinkingLevel,
      error: detail,
    });
    return request(ctx, model, options, undefined);
  }
}

/** Issues one request and joins the assistant's text blocks. */
async function request(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
  options: NestedCallOptions,
  thinkingLevel: ThinkingLevel | undefined,
): Promise<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const stream = ctx.modelRegistry.streamSimple(
    model,
    {
      systemPrompt: options.systemPrompt,
      messages: [
        {
          role: "user",
          content: options.userContent,
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
      maxTokens: options.maxTokens,
      ...(thinkingLevel === undefined ? {} : { reasoning: thinkingLevel }),
    },
  );

  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      finalMessage = event.message;
    } else if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "Model request failed.");
    }
  }
  if (!finalMessage) {
    throw new Error("Model returned no final message.");
  }
  options.onResponse?.(finalMessage);
  return finalMessage.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** Resolves a provider/model-id string or reports why it cannot be used. */
export function resolveConfiguredModel(
  ctx: ExtensionContext,
  configuredModel: string | undefined,
  label: string,
  reportWarning: (message: string) => void,
): ExtensionContext["model"] {
  if (!configuredModel) {
    return ctx.model;
  }
  const slash = configuredModel.indexOf("/");
  if (slash <= 0 || slash === configuredModel.length - 1) {
    reportWarning(
      `pi-friend ${label} "${configuredModel}" must use provider/model-id; using the session model.`,
    );
    return ctx.model;
  }
  const found = ctx.modelRegistry.find(
    configuredModel.slice(0, slash),
    configuredModel.slice(slash + 1),
  );
  if (!found) {
    reportWarning(
      `pi-friend ${label} "${configuredModel}" was not found; using the session model.`,
    );
    return ctx.model;
  }
  return found;
}
