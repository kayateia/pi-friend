/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  DreamingConfig,
  SweepConfig,
} from "./config.ts";
import type { MemoryNodeService } from "./service.ts";
import { isQuarantinedMemoryType } from "./schema.ts";
import { planCandidateDecay } from "./decay.ts";
import {
  DREAM_SYSTEM_PROMPT,
  resolveSweepSystemPrompt,
  resolveSystemPrompt,
} from "./prompts.ts";
import {
  runSweepModel,
  type SweepDecision,
} from "./sweep-model.ts";
import {
  runDreamModel,
  selectDreamShortlist,
  type DreamDraft,
} from "./dream.ts";
import { formatErrorChain } from "../debug/log.ts";

interface SweepState {
  version: 1;
  lastAttemptAt: string;
  lastSuccessfulAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastRunId?: string;
  preimage?: string;
}

/** Summary of one daily sweep invocation. */
export interface SweepResult {
  ran: boolean;
  runId?: string;
  promoted: number;
  merged: number;
  dropped: number;
  decayUpdates: number;
  preimage?: string;
  dreamSlug?: string;
  dreamError?: string;
  error?: string;
}

/** Optional overrides and cancellation for one sweep run. */
export interface RunDailySweepOptions {
  force?: boolean;
  now?: Date;
  dreaming?: DreamingConfig;
  random?: () => number;
  signal?: AbortSignal;
  decide?: (
    candidates: Awaited<ReturnType<MemoryNodeService["listStagingCandidates"]>>,
    canonical: Awaited<ReturnType<MemoryNodeService["listCanonicalNodes"]>>,
    signal?: AbortSignal,
  ) => Promise<SweepDecision[]>;
  dream?: (
    shortlist: Awaited<ReturnType<MemoryNodeService["listCanonicalNodes"]>>,
    maxNodes: number,
    signal?: AbortSignal,
  ) => Promise<DreamDraft>;
  reportWarning?: (message: string) => void;
  reportError?: (label: string, error: unknown) => void;
}

/**
 * Runs the daily consolidation pass once when it has not succeeded today.
 *
 * A preimage is captured before mutations, state advances on every attempt,
 * and the dated sweep log records both successful and failed outcomes.
 */
export async function runDailySweep(
  ctx: ExtensionContext | undefined,
  service: MemoryNodeService,
  config: SweepConfig,
  options: RunDailySweepOptions = {},
): Promise<SweepResult> {
  if (!config.enabled) {
    return emptyResult(false);
  }
  return service.runExclusive(() =>
    runDailySweepLocked(ctx, service, config, options),
  );
}

/** Executes a sweep while the service's exclusive mutation lock is held. */
async function runDailySweepLocked(
  ctx: ExtensionContext | undefined,
  service: MemoryNodeService,
  config: SweepConfig,
  options: RunDailySweepOptions,
): Promise<SweepResult> {
  options.signal?.throwIfAborted();
  const now = options.now ?? new Date();
  const previous = await readSweepState(service, options.reportError);
  if (
    options.force !== true &&
    previous.lastSuccessfulAt !== undefined &&
    localDate(new Date(previous.lastSuccessfulAt)) === localDate(now)
  ) {
    return emptyResult(false);
  }

  const runId = timestampId(now);
  const attemptedAt = now.toISOString();
  let preimage: string | undefined;
  let decisions: SweepDecision[] = [];
  let promoted = 0;
  let merged = 0;
  let dropped = 0;
  let decayUpdates = 0;
  let dreamSlug: string | undefined;
  let dreamError: string | undefined;

  try {
    const allCandidates = await service.listStagingCandidates();
    const canonical = await service.listCanonicalNodes();
    // Dreams are canonical but must never be merge targets: merging ordinary
    // content into one would turn fiction into memory. Withdrawing them here
    // keeps them out of the model's window and out of a custom decider's, so the
    // prompt need not warn about a target that cannot appear.
    const mergeTargets = canonical.filter(
      (node) => !isQuarantinedMemoryType(node.frontMatter.type),
    );
    const candidateDecay = planCandidateDecay(allCandidates, canonical);
    const expiredSet = new Set(candidateDecay.expiredSlugs);
    const candidates = allCandidates.filter(
      (candidate) => !expiredSet.has(candidate.slug),
    );
    if (candidates.length > 0) {
      if (options.decide) {
        decisions = await options.decide(
          candidates,
          mergeTargets,
          options.signal,
        );
      } else {
        if (!ctx) {
          throw new Error("Sweep model context is unavailable.");
        }
        decisions = await runSweepModel(
          ctx,
          config.model,
          candidates,
          mergeTargets,
          options.reportWarning ?? (() => {}),
          options.signal,
          resolveSweepSystemPrompt(config, config.allowDrop),
          config.allowDrop,
        );
      }
      options.signal?.throwIfAborted();
    }

    // Model-requested drops are destructive too, so they count against the same
    // guard. Otherwise enabling `allow_drop` would quietly turn a rate limit on
    // deletion into no limit at all.
    const modelDrops = decisions.filter(
      (decision) => decision.action === "drop",
    ).length;
    const destructiveActions =
      candidateDecay.expiredSlugs.length + modelDrops;
    const ratioGuardApplies =
      allCandidates.length >= config.minGuardedBatchSize;
    if (
      ratioGuardApplies &&
      destructiveActions > Math.floor(allCandidates.length * 0.25)
    ) {
      throw new Error(
        `Sweep would remove more than 25% of ${allCandidates.length} staged candidates; the guard applies at ${config.minGuardedBatchSize} or more.`,
      );
    }

    if (config.preimageKeep > 0) {
      preimage = await createPreimage(service, runId);
      options.signal?.throwIfAborted();
    }
    await prunePreimages(service, config.preimageKeep);
    options.signal?.throwIfAborted();

    await service.applyCandidateDecay(candidateDecay.updates);
    for (const slug of candidateDecay.expiredSlugs) {
      options.signal?.throwIfAborted();
      await service.archiveCandidate(slug, runId);
      dropped += 1;
    }

    for (const decision of decisions) {
      options.signal?.throwIfAborted();
      if (decision.action === "drop") {
        await service.archiveCandidate(decision.slug, runId);
        dropped += 1;
        continue;
      }
      const result = await service.promoteCandidate(
        decision.slug,
        decision.action === "merge" ? decision.target : undefined,
      );
      if (result.merged) {
        merged += 1;
      } else {
        promoted += 1;
      }
    }

    options.signal?.throwIfAborted();
    decayUpdates = (await service.recomputeDecay()).length;
    options.signal?.throwIfAborted();

    if (options.dreaming?.enabled) {
      try {
        const eligible = (await service.listCanonicalNodes()).filter(
          (node) =>
            node.frontMatter.status === "active" &&
            !isQuarantinedMemoryType(node.frontMatter.type),
        );
        if (eligible.length >= 2) {
          const shortlist = selectDreamShortlist(
            eligible,
            options.dreaming.maxNodes,
            options.random,
          );
          const draft = options.dream
            ? await options.dream(
                shortlist,
                options.dreaming.maxNodes,
                options.signal,
              )
            : ctx
              ? await runDreamModel(
                  ctx,
                  options.dreaming.model,
                  shortlist,
                  options.dreaming.maxNodes,
                  options.reportWarning ?? (() => {}),
                  options.signal,
                  resolveSystemPrompt(DREAM_SYSTEM_PROMPT, options.dreaming),
                )
              : (() => {
                  throw new Error("Dream model context is unavailable.");
                })();
          options.signal?.throwIfAborted();
          const dream = await service.createDream({
            ...draft,
            source: `sweep:${runId}`,
          });
          dreamSlug = dream.slug;
        }
      } catch (error) {
        if (!options.signal?.aborted) {
          options.reportError?.("sweep dream", error);
        }
        dreamError = formatErrorChain(error);
      }
    }

    await appendSweepLog(service, runId, attemptedAt, {
      decisions,
      promoted,
      merged,
      dropped,
      decayUpdates,
      preimage,
      dreamSlug,
      dreamError,
    });
    await writeSweepState(service, {
      version: 1,
      lastAttemptAt: attemptedAt,
      lastSuccessfulAt: attemptedAt,
      lastRunId: runId,
      preimage,
    });

    return {
      ran: true,
      runId,
      promoted,
      merged,
      dropped,
      decayUpdates,
      preimage,
      ...(dreamSlug === undefined ? {} : { dreamSlug }),
      ...(dreamError === undefined ? {} : { dreamError }),
    };
  } catch (error) {
    if (!options.signal?.aborted) {
      options.reportError?.("daily sweep", error);
    }
    const message = formatErrorChain(error);
    await appendSweepLog(service, runId, attemptedAt, {
      decisions,
      promoted,
      merged,
      dropped,
      decayUpdates,
      preimage,
      dreamSlug,
      dreamError,
      error: message,
    }).catch((appendError) => {
      options.reportError?.("sweep failure log", appendError);
    });
    await writeSweepState(service, {
      version: 1,
      lastAttemptAt: attemptedAt,
      lastFailureAt: attemptedAt,
      lastError: message,
      lastRunId: runId,
      preimage,
    }).catch((stateError) => {
      options.reportError?.("sweep failure state", stateError);
    });
    return {
      ran: true,
      runId,
      promoted,
      merged,
      dropped,
      decayUpdates,
      ...(preimage === undefined ? {} : { preimage }),
      ...(dreamSlug === undefined ? {} : { dreamSlug }),
      ...(dreamError === undefined ? {} : { dreamError }),
      error: message,
    };
  }
}

/**
 * Deletes preimages beyond the configured retention count.
 *
 * Run identifiers are ISO timestamps, so lexicographic order is chronological:
 * the newest `keep` directories survive and older ones are removed. A `keep` of
 * zero removes every preimage, which is how preimages are disabled — the caller
 * stops creating them at the same time, so this only has to clean up.
 */
async function prunePreimages(
  service: MemoryNodeService,
  keep: number,
): Promise<void> {
  const directory = path.join(service.store.paths.sweeps, "preimages");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }

  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const excess = runIds.slice(0, Math.max(0, runIds.length - keep));
  for (const runId of excess) {
    await rm(path.join(directory, runId), { recursive: true, force: true });
  }
}

/** Returns a Node filesystem error code without relying on an any cast. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

/** Captures a full preimage of canonical files before sweep mutation. */
async function createPreimage(
  service: MemoryNodeService,
  runId: string,
): Promise<string> {
  const root = service.store.paths.root;
  const relative = `sweeps/preimages/${runId}`;
  const destination = path.join(service.store.paths.root, relative);
  await mkdir(destination, { recursive: true, mode: 0o700 });

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "index" || entry.name === "sweeps") {
      continue;
    }
    await cp(
      path.join(root, entry.name),
      path.join(destination, entry.name),
      { recursive: entry.isDirectory(), preserveTimestamps: true },
    );
  }

  const sweepSource = service.store.paths.sweeps;
  const sweepDestination = path.join(destination, "sweeps");
  await mkdir(sweepDestination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(sweepSource, { withFileTypes: true })) {
    if (entry.name === "preimages") {
      continue;
    }
    await cp(
      path.join(sweepSource, entry.name),
      path.join(sweepDestination, entry.name),
      { recursive: entry.isDirectory(), preserveTimestamps: true },
    );
  }
  return relative;
}

/** Appends one dated sweep section without rewriting prior sections. */
async function appendSweepLog(
  service: MemoryNodeService,
  runId: string,
  attemptedAt: string,
  summary: {
    decisions: SweepDecision[];
    promoted: number;
    merged: number;
    dropped: number;
    decayUpdates: number;
    dreamSlug?: string;
    dreamError?: string;
    preimage?: string;
    error?: string;
  },
): Promise<void> {
  const date = localDate(new Date(attemptedAt));
  const relative = `sweeps/${date}.md`;
  const existing =
    (await service.store.readTextFileIfExists(relative)) ?? "";
  const lines = [
    `## Sweep ${attemptedAt}`,
    "",
    `- Run ID: ${runId}`,
    `- Preimage: ${summary.preimage ?? "not created"}`,
    `- Promoted: ${summary.promoted}`,
    `- Merged: ${summary.merged}`,
    `- Dropped/archived: ${summary.dropped}`,
    `- Decay updates: ${summary.decayUpdates}`,
    `- Dream: ${summary.dreamSlug ?? "none"}`,
    ...(summary.dreamError ? [`- Dream error: ${summary.dreamError}`] : []),
    ...(summary.error ? [`- Error: ${summary.error}`] : []),
    "",
    "### Candidate decisions",
    ...(summary.decisions.length === 0
      ? ["- None"]
      : summary.decisions.map(
          (decision) =>
            `- ${decision.slug}: ${decision.action}${decision.target ? ` → ${decision.target}` : ""} — ${decision.reason}`,
        )),
  ];
  const separator = existing.trim() ? "\n\n" : "";
  await service.store.writeTextFile(
    relative,
    `${existing}${separator}${lines.join("\n")}\n`,
  );
}

/** Reads sweep state, returning undefined for missing or malformed state. */
async function readSweepState(
  service: MemoryNodeService,
  reportError?: (label: string, error: unknown) => void,
): Promise<Partial<SweepState>> {
  const source = await service.store.readTextFileIfExists(
    "sweeps/state.json",
  );
  if (!source) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    reportError?.(
      "sweep state parse",
      new Error("Sweeps/state.json is not valid JSON.", { cause: error }),
    );
    return {};
  }
  if (!isRecord(value)) {
    reportError?.(
      "sweep state parse",
      new Error("Sweeps/state.json must contain a JSON object."),
    );
    return {};
  }
  return {
    ...(typeof value.lastSuccessfulAt === "string"
      ? { lastSuccessfulAt: value.lastSuccessfulAt }
      : {}),
  };
}

/** Persists sweep state atomically. */
async function writeSweepState(
  service: MemoryNodeService,
  state: SweepState,
): Promise<void> {
  await service.store.writeJsonFile(
    "sweeps/state.json",
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** Formats a filesystem-safe run identifier. */
function timestampId(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

/** Returns a local calendar date for once-per-day checks. */
function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Returns an empty non-run result. */
function emptyResult(ran: boolean): SweepResult {
  return {
    ran,
    promoted: 0,
    merged: 0,
    dropped: 0,
    decayUpdates: 0,
  };
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
