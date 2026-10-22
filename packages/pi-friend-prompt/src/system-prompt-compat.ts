/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPackageDir,
  type BuildSystemPromptOptions,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

type SectionBuilder = (
  input: BuildSystemPromptOptions,
) => Record<string, string>;

type OptionsNormalizer = (
  input: BuildSystemPromptOptions,
) => NormalizedBuildSystemPromptOptions;

/** Internal Pi system-prompt functions used by the extension. */
export interface SystemPromptApi {
  buildSystemPromptSections: SectionBuilder;
  normalizeBuildSystemPromptOptions: OptionsNormalizer;
}

/** Error raised when Pi's internal prompt API is unavailable. */
export class SystemPromptCompatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SystemPromptCompatError";
  }
}

let apiPromise: Promise<SystemPromptApi> | undefined;

/**
 * Loads Pi's system-prompt builder through its package directory.
 *
 * Pi does not export this module through package `exports`, so a direct import
 * fails. The absolute file URL is isolated here and validated at runtime.
 */
export function loadSystemPromptApi(): Promise<SystemPromptApi> {
  apiPromise ??= loadUncached();
  return apiPromise;
}

/** Performs the actual internal-module load and shape validation. */
async function loadUncached(): Promise<SystemPromptApi> {
  const modulePath = path.join(
    getPackageDir(),
    "dist",
    "core",
    "system-prompt.js",
  );
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new SystemPromptCompatError(
      `Could not load Pi system-prompt helpers from ${modulePath}.`,
      { cause: error },
    );
  }

  if (
    !isRecord(loaded) ||
    !isSectionBuilder(loaded.buildSystemPromptSections) ||
    !isOptionsNormalizer(loaded.normalizeBuildSystemPromptOptions)
  ) {
    throw new SystemPromptCompatError(
      "Pi's internal system-prompt helper API has changed.",
    );
  }

  return {
    buildSystemPromptSections: loaded.buildSystemPromptSections,
    normalizeBuildSystemPromptOptions:
      loaded.normalizeBuildSystemPromptOptions,
  };
}

/** Narrows an unknown value to the section-builder function. */
function isSectionBuilder(value: unknown): value is SectionBuilder {
  return typeof value === "function";
}

/** Narrows an unknown value to the options-normalizer function. */
function isOptionsNormalizer(value: unknown): value is OptionsNormalizer {
  return typeof value === "function";
}

/** Narrows unknown module values to records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
