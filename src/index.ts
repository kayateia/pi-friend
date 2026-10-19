/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers the pi-friend-memory extension.
 *
 * The initial skeleton exposes a command so the extension can be loaded and
 * exercised before memory storage and retrieval are implemented.
 */
export default function registerPiFriend(pi: ExtensionAPI): void {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      // An empty argument should still produce a friendly greeting.
      const recipient = name?.trim() || "world";

      ctx.ui.notify(`Hello, ${recipient}!`, "info");
    },
  });
}
