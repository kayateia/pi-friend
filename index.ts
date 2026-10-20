/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHookLogging } from "./src/debug/hook-log.ts";
import { MemoryNodeRepository } from "./src/memory/repository.ts";
import { MemoryNodeService } from "./src/memory/service.ts";
import { registerMemoryTools } from "./src/tools/memory-tools.ts";

/**
 * Pi-facing composition root for the pi-friend-memory extension.
 *
 * Lifecycle hooks and memory tools will be registered here. The temporary
 * command keeps package loading independently testable while storage and
 * retrieval are still being designed.
 */
export default function registerPiFriend(pi: ExtensionAPI): void {
  // The memory service is session-scoped and shared by all memory tools.
  let memoryService: MemoryNodeService | undefined;

  // Temporary opt-in instrumentation for inspecting Pi's lifecycle payloads.
  registerHookLogging(pi);
  registerMemoryTools(pi, () => memoryService);

  pi.on("session_start", async (_event, ctx) => {
    try {
      memoryService = new MemoryNodeService(
        await MemoryNodeRepository.open(),
      );
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
    memoryService = undefined;
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
