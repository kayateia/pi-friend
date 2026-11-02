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
import type {
  ResolvedPromptConfig,
  ResolvedPromptReplacement,
} from "./prompt-files.ts";

type SectionBuilder = (
  input: BuildSystemPromptOptions,
) => Record<string, string>;

/** Result of applying one resolved prompt configuration. */
export interface PromptEditResult {
  changed: boolean;
  narrative?: string;
}

/**
 * Applies resolved preamble, addendum, section, and replacement edits.
 *
 * All work happens on a draft so a malformed replacement cannot leave the
 * request with a partially edited system prompt.
 */
export function applyPromptConfig(
  options: NormalizedBuildSystemPromptOptions,
  config: ResolvedPromptConfig,
  buildSections: SectionBuilder,
): PromptEditResult {
  const draft: NormalizedBuildSystemPromptOptions = {
    ...options,
    sections: { ...options.sections },
  };
  const stock = buildSections({
    ...options,
    customPrompt: undefined,
  });
  let customNarrative = config.custom;
  let addendumNarrative = config.addendum;

  if (config.custom !== undefined) {
    ensureGeneratedSections(draft, stock);
    draft.customPrompt = config.custom;
  }
  if (config.addendum !== undefined) {
    draft.appendSystemPrompt = config.addendum;
  }
  Object.assign(draft.sections, config.sections);

  for (const replacement of config.replacements) {
    const replacementNarrative = applyReplacement(
      draft,
      replacement,
      buildSections,
      stock,
    );
    if (replacementNarrative !== undefined) {
      if (replacement.section === "preamble") {
        customNarrative = replacementNarrative;
      } else if (replacement.section === "addendum") {
        addendumNarrative = replacementNarrative;
      }
    }
  }

  const changed =
    draft.customPrompt !== options.customPrompt ||
    draft.appendSystemPrompt !== options.appendSystemPrompt ||
    !sameRecord(draft.sections, options.sections);
  if (changed) {
    options.customPrompt = draft.customPrompt;
    options.appendSystemPrompt = draft.appendSystemPrompt;
    options.sections = draft.sections;
  }

  const diagnosticNarrative =
    customNarrative?.trim() || addendumNarrative?.trim() || undefined;
  return {
    changed,
    ...(diagnosticNarrative === undefined
      ? {}
      : { narrative: diagnosticNarrative }),
  };
}

/**
 * Backward-compatible helper for replacing only the prompt preamble.
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
  return applyPromptConfig(
    options,
    {
      custom: narrative,
      sections: {},
      replacements: [],
    },
    buildSections,
  ).changed;
}

/** Applies one replacement rule to the current rendered section text. */
function applyReplacement(
  draft: NormalizedBuildSystemPromptOptions,
  replacement: ResolvedPromptReplacement,
  buildSections: SectionBuilder,
  stock: Record<string, string>,
): string | undefined {
  const sections = buildSections(draft);
  const current = readSection(sections, replacement.section);
  if (current === undefined) {
    throw new Error(
      `Prompt replacement target "${replacement.section}" does not exist.`,
    );
  }

  const next = replaceSectionText(current, replacement);
  if (replacement.section === "preamble") {
    if (next.trim() === "") {
      throw new Error("Prompt replacement produced an empty preamble.");
    }
    ensureGeneratedSections(draft, stock);
    draft.customPrompt = next;
    buildSections(draft);
    return next;
  } else if (replacement.section === "addendum") {
    draft.appendSystemPrompt = next;
    buildSections(draft);
    return next;
  } else {
    if (next.trim() === "") {
      throw new Error(
        `Prompt replacement produced an empty "${replacement.section}" section.`,
      );
    }
    draft.sections[replacement.section] = next;
  }

  // Validate the complete edited prompt before the caller commits the draft.
  buildSections(draft);
  return undefined;
}

/**
 * Applies replacement text to a whole section or each regex match.
 *
 * Regex replacements use JavaScript replacement syntax. Prepend and append
 * preserve each match while placing the new text before or after it.
 */
function replaceSectionText(
  current: string,
  replacement: ResolvedPromptReplacement,
): string {
  if (replacement.pattern === undefined) {
    return combineText(current, replacement.replacementText, replacement.action);
  }

  const expression = new RegExp(replacement.pattern, replacement.flags);
  const replacementTemplate =
    replacement.action === "replace"
      ? replacement.replacementText
      : replacement.action === "prepend"
        ? `${replacement.replacementText}$&`
        : `$&${replacement.replacementText}`;
  return current.replace(expression, replacementTemplate);
}

/** Combines text with a whole section without interpreting replacement tokens. */
function combineText(
  current: string,
  replacement: string,
  action: ResolvedPromptReplacement["action"],
): string {
  if (action === "prepend") {
    return `${replacement}${current}`;
  }
  if (action === "append") {
    return `${current}${replacement}`;
  }
  return replacement;
}

/** Reads an unwrapped section by its logical prompt name. */
function readSection(
  sections: Record<string, string>,
  name: string,
): string | undefined {
  if (name === "preamble") {
    return sections.preamble;
  }
  const section = sections[name];
  return typeof section === "string" ? unwrapSection(name, section) : undefined;
}

/**
 * Keeps generated tool, rule, and documentation sections when a custom
 * preamble would otherwise cause Pi to omit them.
 */
function ensureGeneratedSections(
  draft: NormalizedBuildSystemPromptOptions,
  stock: Record<string, string>,
): void {
  for (const name of ["tools", "rules", "docs"] as const) {
    if (draft.sections[name] !== undefined) {
      continue;
    }
    const section = stock[name];
    if (typeof section === "string") {
      draft.sections[name] = unwrapSection(name, section);
    }
  }
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

/** Compares two string maps by key and value. */
function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}
