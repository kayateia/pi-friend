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
} from "@earendil-works/pi-coding-agent";
import { loadPromptConfig } from "./src/config.ts";
import { promptDebugLog } from "./src/debug-log.ts";
import { applyCustomPrompt } from "./src/editor.ts";
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
 * The extension reads the shared pi-friend config on every agent start so
 * changes to prompt.custom become visible without restarting Pi.
 */
export default function registerPiFriendPrompt(pi: ExtensionAPI): void {
  let warningShown = false;
  const promptRuns = new Map<string, PromptRunState>();

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    promptRuns.set(sessionId, {
      options: event.systemPromptOptions,
    });
    try {
      const config = await loadPromptConfig();
      if (!config.customPrompt) {
        return;
      }

      const api = await loadSystemPromptApi();
      applyCustomPrompt(
        event.systemPromptOptions,
        config.customPrompt,
        api.buildSystemPromptSections,
      );
      promptRuns.set(sessionId, {
        options: event.systemPromptOptions,
        narrative: config.customPrompt.trim(),
      });
    } catch (error) {
      if (!warningShown) {
        warningShown = true;
        const message = `pi-friend-prompt: ${describeError(error)}`;
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        } else {
          console.error(message);
        }
      }
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

/** Formats unknown thrown values for a warning. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
