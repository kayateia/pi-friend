/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  debugLog,
  isDebugEnabled,
} from "./log.ts";

/**
 * Writes one complete hook invocation to the debug log.
 *
 * Every Pi event handler receives the event-specific payload first and the
 * shared ExtensionContext second. Logging both makes it possible to inspect
 * which fields are available before memory behavior is attached to them.
 */
function logHook(event: ExtensionEvent, ctx: ExtensionContext): void {
  debugLog(`hook ${event.type}`, {
    event,
    context: ctx,
    contextValues: {
      cwd: ctx.cwd,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      sessionId: ctx.sessionManager.getSessionId(),
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
      idle: ctx.isIdle(),
      projectTrusted: ctx.isProjectTrusted(),
      hasPendingMessages: ctx.hasPendingMessages(),
      hasAbortSignal: ctx.signal !== undefined,
      contextUsage: ctx.getContextUsage(),
      systemPromptChars: ctx.getSystemPrompt().length,
    },
  });
}

/**
 * Registers temporary instrumentation for Pi's structural lifecycle hooks.
 *
 * Streaming hooks are intentionally omitted because they fire for every token
 * or partial tool update and would overwhelm the useful lifecycle output.
 */
export function registerHookLogging(pi: ExtensionAPI): void {
  if (!isDebugEnabled()) {
    return;
  }

  // Resource and MCP discovery.
  pi.on("resources_discover", logHook);
  pi.on("mcp_servers_change", logHook);

  // Session lifecycle and transitions.
  pi.on("session_start", logHook);
  pi.on("session_info_changed", logHook);
  pi.on("session_before_switch", logHook);
  pi.on("session_before_fork", logHook);
  pi.on("session_before_compact", logHook);
  pi.on("session_compact", logHook);
  pi.on("session_compact_failed", logHook);
  pi.on("session_shutdown", logHook);
  pi.on("session_before_tree", logHook);
  pi.on("session_tree", logHook);

  // Agent, turn, and message lifecycle.
  pi.on("before_agent_start", logHook);
  pi.on("agent_start", logHook);
  pi.on("agent_end", logHook);
  pi.on("agent_before_settle", logHook);
  pi.on("agent_settled", logHook);
  pi.on("turn_start", logHook);
  pi.on("turn_end", logHook);
  pi.on("message_start", logHook);
  pi.on("message_end", logHook);

  // Prompt, provider, and cache boundaries.
  pi.on("context", logHook);
  pi.on("context_with_system", logHook);
  pi.on("cache_warming_decision", logHook);
  pi.on("before_provider_request", logHook);
  pi.on("before_provider_headers", logHook);
  pi.on("after_provider_response", logHook);

  // Tools, user input, model selection, and UI prompts.
  pi.on("tool_call", logHook);
  pi.on("tool_result", logHook);
  pi.on("tool_execution_start", logHook);
  pi.on("tool_execution_end", logHook);
  pi.on("user_bash", logHook);
  pi.on("input", logHook);
  pi.on("model_select", logHook);
  pi.on("thinking_level_select", logHook);
  pi.on("ui_prompt_start", logHook);
  pi.on("ui_prompt_end", logHook);
}
