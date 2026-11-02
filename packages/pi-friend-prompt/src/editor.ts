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
  ResolvedPromptChange,
  ResolvedPromptConfig,
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
 * Applies ordered prompt changes to a draft request.
 *
 * Every change sees the output of all earlier changes, including repeated
 * changes to the same section. A failure leaves the original options intact.
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
  let customNarrative: string | undefined;
  let addendumNarrative: string | undefined;

  for (const change of config.changes) {
    const narrative = applyChange(draft, change, buildSections, stock);
    if (change.section === "preamble") {
      customNarrative = narrative;
    } else if (change.section === "addendum") {
      addendumNarrative = narrative;
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

/** Backward-compatible helper for replacing only the prompt preamble. */
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
      changes: [
        {
          section: "preamble",
          action: "replace",
          files: [],
          sourceText: narrative,
          flags: "",
        },
      ],
    },
    buildSections,
  ).changed;
}

/** Applies one change and returns the resulting preamble or addendum text. */
function applyChange(
  draft: NormalizedBuildSystemPromptOptions,
  change: ResolvedPromptChange,
  buildSections: SectionBuilder,
  stock: Record<string, string>,
): string | undefined {
  const sections = buildSections(draft);
  let current = readSection(sections, change.section);
  if (current === undefined) {
    current = initialMissingSection(change);
    if (current === undefined) {
      throw new Error(
        `Prompt section "${change.section}" does not exist. ` +
          "Use a whole-section replace first to create it.",
      );
    }
  }

  const next = changeText(current, change);
  if (change.section === "preamble") {
    if (next.trim() === "") {
      throw new Error("Prompt change produced an empty preamble.");
    }
    preserveGeneratedSections(draft, stock);
    draft.customPrompt = next;
    buildSections(draft);
    return next;
  }
  if (change.section === "addendum") {
    draft.appendSystemPrompt = next;
    buildSections(draft);
    return next;
  }
  if (next.trim() === "") {
    throw new Error(
      `Prompt change produced an empty "${change.section}" section.`,
    );
  }
  draft.sections[change.section] = next;
  buildSections(draft);
  return undefined;
}

/** Returns the starting text for a section that is not currently rendered. */
function initialMissingSection(
  change: ResolvedPromptChange,
): string | undefined {
  if (change.section === "addendum") {
    return "";
  }
  if (change.action === "replace" && change.pattern === undefined) {
    return "";
  }
  return undefined;
}

/**
 * Applies source text to a whole section or each regular-expression match.
 *
 * Whole-section prepend and append insert a blank line between prose blocks.
 * Pattern operations use JavaScript replacement syntax directly.
 */
function changeText(current: string, change: ResolvedPromptChange): string {
  if (change.pattern === undefined) {
    if (change.action === "replace") {
      return change.sourceText;
    }
    if (current === "") {
      return change.sourceText;
    }
    if (change.action === "prepend") {
      return `${change.sourceText}\n\n${current}`;
    }
    return `${current}\n\n${change.sourceText}`;
  }

  const expression = new RegExp(change.pattern, change.flags);
  const replacement =
    change.action === "replace"
      ? change.sourceText
      : change.action === "prepend"
        ? `${change.sourceText}$&`
        : `$&${change.sourceText}`;
  return current.replace(expression, replacement);
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
function preserveGeneratedSections(
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
