/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BuildSystemPromptOptions,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

type SectionBuilder = (
  input: BuildSystemPromptOptions,
) => Record<string, string>;

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
