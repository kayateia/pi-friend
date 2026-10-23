/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPromptConfig } from "./src/config.ts";
import {
  applyCustomPrompt,
  injectPromptFallback,
} from "./src/editor.ts";
import { loadSystemPromptApi } from "./src/system-prompt-compat.ts";

/**
 * Registers configurable system-prompt editing.
 *
 * The extension reads the shared pi-friend config on every agent start so
 * changes to prompt.custom become visible without restarting Pi.
 */
export default function registerPiFriendPrompt(pi: ExtensionAPI): void {
  let warningShown = false;

  pi.on("before_agent_start", async (event, ctx) => {
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
    try {
      const config = await loadPromptConfig();
      const customPrompt = config.customPrompt?.trim();
      if (!customPrompt || ctx.getSystemPrompt().includes(customPrompt)) {
        return;
      }

      return {
        messages: injectPromptFallback(event.messages, customPrompt),
      };
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
}

/** Formats unknown thrown values for a warning. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
