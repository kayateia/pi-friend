/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHookLogging } from "./src/debug/hook-log.ts";
import { MemoryStore } from "./src/memory/store.ts";

/**
 * Pi-facing composition root for the pi-friend-memory extension.
 *
 * Lifecycle hooks and memory tools will be registered here. The temporary
 * command keeps package loading independently testable while storage and
 * retrieval are still being designed.
 */
export default function registerPiFriend(pi: ExtensionAPI): void {
  // The store is session-scoped and becomes available to future memory tools.
  let memoryStore: MemoryStore | undefined;

  // Temporary opt-in instrumentation for inspecting Pi's lifecycle payloads.
  registerHookLogging(pi);

  pi.on("session_start", async (_event, ctx) => {
    try {
      memoryStore = await MemoryStore.open();
    } catch (error) {
      const message = `pi-friend memory initialization failed: ${describeError(error)}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      } else {
        console.error(message);
      }
    }
  });

  pi.on("session_shutdown", () => {
    memoryStore = undefined;
  });

  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      // An empty argument should still produce a friendly greeting.
      const recipient = name?.trim() || "world";

      ctx.ui.notify(`Hello, ${recipient}!`, "info");
    },
  });
}

/** Formats unknown thrown values for a user-visible initialization error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
