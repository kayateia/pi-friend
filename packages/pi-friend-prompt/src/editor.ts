/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BuildSystemPromptOptions,
  ContextWithSystemEvent,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

type SectionBuilder = (
  input: BuildSystemPromptOptions,
) => Record<string, string>;

type PromptContextMessage = Extract<
  ContextWithSystemEvent["messages"][number],
  { role: "custom" }
>;

/**
 * Replaces only the prompt preamble while restoring stock generated sections.
 *
 * Pi omits tools/rules/docs automatically when a custom prompt is present, so
 * those sections are rebuilt from the unchanged options and explicitly kept.
 */
export function applyCustomPrompt(
  options: NormalizedBuildSystemPromptOptions,
  customPrompt: string,
  buildSections: SectionBuilder,
): boolean {
  const narrative = customPrompt.trim();
  if (narrative === "") {
    return false;
  }

  const stock = buildSections({
    ...options,
    customPrompt: undefined,
  });
  options.customPrompt = narrative;
  options.sections = {
    ...options.sections,
    ...(typeof stock.tools === "string"
      ? { tools: unwrapSection("tools", stock.tools) }
      : {}),
    ...(typeof stock.rules === "string"
      ? { rules: unwrapSection("rules", stock.rules) }
      : {}),
    ...(typeof stock.docs === "string"
      ? { docs: unwrapSection("docs", stock.docs) }
      : {}),
  };
  return true;
}

/**
 * Builds a non-displayed fallback message for hosts that override the final
 * system prompt after earlier before_agent_start mutations.
 */
export function createPromptFallbackMessage(
  customPrompt: string,
  timestamp: number = Date.now(),
): PromptContextMessage {
  return {
    role: "custom",
    customType: "pi-friend-prompt",
    content: `<pi-friend-prompt>\n${customPrompt.trim()}\n</pi-friend-prompt>`,
    display: false,
    timestamp,
  };
}

/**
 * Inserts the fallback after the leading system message when present, keeping
 * provider-required prompt and tool declarations first.
 */
export function injectPromptFallback(
  messages: ContextWithSystemEvent["messages"],
  customPrompt: string,
  timestamp: number = Date.now(),
): ContextWithSystemEvent["messages"] {
  const fallback = createPromptFallbackMessage(customPrompt, timestamp);
  if (messages[0]?.role === "system") {
    return [messages[0], fallback, ...messages.slice(1)];
  }
  return [fallback, ...messages];
}

/** Removes one automatic section wrapper before storing its inner content. */
function unwrapSection(name: string, section: string): string {
  const opening = `<${name}>`;
  const closing = `</${name}>`;
  const trimmed = section.trim();
  if (trimmed.startsWith(opening) && trimmed.endsWith(closing)) {
    return trimmed.slice(opening.length, -closing.length).trim();
  }
  return section;
}
