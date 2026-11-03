/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hasPromptEdits, loadPromptConfig } from "./src/config.ts";
import { promptDebugLog } from "./src/debug-log.ts";
import { applyPromptConfig } from "./src/editor.ts";
import { resolvePromptConfig } from "./src/prompt-files.ts";
import { loadSystemPromptApi } from "./src/system-prompt-compat.ts";
import {
  analyzePromptDelivery,
  readWebUiPromptSettings,
} from "./src/web-ui-diagnostics.ts";

/** Prompt state captured for one run and inspected after later handlers. */
interface PromptRunState {
  options: BeforeAgentStartEvent["systemPromptOptions"];
  narrative?: string;
}

/**
 * Registers configurable system-prompt editing.
 *
 * The extension reads config and prompt files on every agent start so changes
 * become visible without restarting Pi. Failed builds are reported each time
 * and retried on the next request.
 */
export default function registerPiFriendPrompt(pi: ExtensionAPI): void {
  const promptRuns = new Map<string, PromptRunState>();

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    promptRuns.set(sessionId, {
      options: event.systemPromptOptions,
    });
    try {
      const config = await loadPromptConfig();
      if (!hasPromptEdits(config)) {
        return;
      }

      const resolvedConfig = await resolvePromptConfig(config);
      // Unreadable prompt files are reported but not fatal: the rest of the
      // configuration still applies to this request.
      for (const warning of resolvedConfig.warnings) {
        reportWarning(ctx, warning);
      }
      const api = await loadSystemPromptApi();
      const result = applyPromptConfig(
        event.systemPromptOptions,
        resolvedConfig,
        api.buildSystemPromptSections,
      );
      promptRuns.set(sessionId, {
        options: event.systemPromptOptions,
        ...(result.narrative === undefined
          ? {}
          : { narrative: result.narrative }),
      });
    } catch (error) {
      reportWarning(ctx, describeError(error));
    }
  });

  pi.on("context_with_system", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = promptRuns.get(sessionId);
    promptRuns.delete(sessionId);

    const finalPrompt = ctx.getSystemPrompt();
    const webUi = readWebUiPromptSettings();
    const delivery = analyzePromptDelivery(
      finalPrompt,
      state?.narrative,
      state?.options.forceSystemPrompt,
      webUi,
    );

    promptDebugLog("web-ui prompt diagnostics", {
      sessionId,
      ...delivery,
      webUi,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    promptRuns.delete(ctx.sessionManager.getSessionId());
  });

  pi.on("session_shutdown", () => {
    promptRuns.clear();
  });
}

/** Raises one warning banner, or logs it when the host has no UI. */
function reportWarning(ctx: ExtensionContext, message: string): void {
  const text = `pi-friend-prompt: ${message}`;
  if (ctx.hasUI) {
    ctx.ui.notify(text, "warning");
  } else {
    console.error(text);
  }
}

/** Formats unknown thrown values for a warning. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
