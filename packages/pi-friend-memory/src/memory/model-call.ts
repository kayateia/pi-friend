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
import { debugLog } from "../debug/log.ts";

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
    debugLog("nested call retry without thinking level", {
      thinkingLevel: options.thinkingLevel,
      error: error instanceof Error ? error.message : String(error),
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
