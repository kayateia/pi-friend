/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SweepConfig } from "./config.ts";
import type { MemoryNodeService } from "./service.ts";
import {
  runSweepModel,
  type SweepDecision,
} from "./sweep-model.ts";

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
  error?: string;
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
  options: {
    force?: boolean;
    now?: Date;
    decide?: (
      candidates: Awaited<ReturnType<MemoryNodeService["listStagingCandidates"]>>,
      canonical: Awaited<ReturnType<MemoryNodeService["listCanonicalNodes"]>>,
    ) => Promise<SweepDecision[]>;
    reportWarning?: (message: string) => void;
  } = {},
): Promise<SweepResult> {
  if (!config.enabled) {
    return emptyResult(false);
  }

  const now = options.now ?? new Date();
  const previous = await readSweepState(service);
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

  try {
    const candidates = await service.listStagingCandidates();
    const canonical = await service.listCanonicalNodes();
    if (candidates.length > 0) {
      if (options.decide) {
        decisions = await options.decide(candidates, canonical);
      } else {
        if (!ctx) {
          throw new Error("Sweep model context is unavailable.");
        }
        decisions = await runSweepModel(
          ctx,
          config.model,
          candidates,
          canonical,
          options.reportWarning ?? (() => {}),
        );
      }
    }

    const dropCount = decisions.filter(
      (decision) => decision.action === "drop",
    ).length;
    if (dropCount > Math.floor(candidates.length * 0.25)) {
      throw new Error(
        "Sweep would drop more than 25% of staged candidates; run a smaller batch.",
      );
    }

    preimage = await createPreimage(service, runId);

    for (const decision of decisions) {
      if (decision.action === "drop") {
        await service.archiveCandidate(decision.slug, runId);
        dropped += 1;
      } else {
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
    }

    decayUpdates = (await service.recomputeDecay()).length;
    await appendSweepLog(service, runId, attemptedAt, {
      decisions,
      promoted,
      merged,
      dropped,
      decayUpdates,
      preimage,
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
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendSweepLog(service, runId, attemptedAt, {
      decisions,
      promoted,
      merged,
      dropped,
      decayUpdates,
      preimage,
      error: message,
    }).catch(() => {});
    await writeSweepState(service, {
      version: 1,
      lastAttemptAt: attemptedAt,
      lastFailureAt: attemptedAt,
      lastError: message,
      lastRunId: runId,
      preimage,
    }).catch(() => {});
    return {
      ran: true,
      runId,
      promoted,
      merged,
      dropped,
      decayUpdates,
      ...(preimage === undefined ? {} : { preimage }),
      error: message,
    };
  }
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
): Promise<Partial<SweepState>> {
  const source = await service.store.readTextFileIfExists(
    "sweeps/state.json",
  );
  if (!source) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {};
  }
  if (!isRecord(value)) return {};
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
