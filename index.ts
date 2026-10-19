/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHookLogging } from "./src/debug/hook-log.ts";

/**
 * Pi-facing composition root for the pi-friend-memory extension.
 *
 * Lifecycle hooks and memory tools will be registered here. The temporary
 * command keeps package loading independently testable while storage and
 * retrieval are still being designed.
 */
export default function registerPiFriend(pi: ExtensionAPI): void {
  // Temporary opt-in instrumentation for inspecting Pi's lifecycle payloads.
  registerHookLogging(pi);

  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      // An empty argument should still produce a friendly greeting.
      const recipient = name?.trim() || "world";

      ctx.ui.notify(`Hello, ${recipient}!`, "info");
    },
  });
}
