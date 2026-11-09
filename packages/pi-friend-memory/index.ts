/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerHookLogging } from "./src/debug/hook-log.ts";
import {
  debugLog,
  formatErrorChain,
  isDebugEnabled,
  logError,
  resolveDebugLogPath,
} from "./src/debug/log.ts";
import {
  DEFAULT_MEMORY_TOOL_PREFIX,
  defaultRagInjectionConfig,
  loadMemoryConfig,
} from "./src/memory/config.ts";
import {
  defaultAutoCaptureConfig,
  type AutoCaptureConfig,
  defaultSweepConfig,
  type SweepConfig,
  defaultDreamingConfig,
  type DreamingConfig,
  defaultMergeConfig,
  type MergeConfig,
} from "./src/memory/config.ts";
import {
  buildCaptureWindow,
  captureStartIndex,
  CaptureResponseError,
} from "./src/memory/capture.ts";
import { compileQueryPrefixes } from "./src/memory/query-prefixes.ts";
import { runCaptureModel } from "./src/memory/capture-runner.ts";
import { createMergeWriter } from "./src/memory/merge-writer.ts";
import { AutoCaptureScheduler } from "./src/memory/capture-scheduler.ts";
import {
  captureStatePath,
  readCaptureCursor,
  writeCaptureCursor,
} from "./src/memory/capture-state.ts";
import {
  OpenRouterEmbeddingProvider,
  resolveOpenRouterApiKey,
} from "./src/memory/embedding.ts";
import { ExternalIndexManager } from "./src/memory/external-index-manager.ts";
import { runPendingMigrations } from "./src/memory/migrations.ts";
import type { MemoryStore } from "./src/memory/store.ts";
import { MemoryNodeRepository } from "./src/memory/repository.ts";
import { buildRagContext } from "./src/memory/rag.ts";
import type { RagRetrievalDiagnostics } from "./src/memory/rag.ts";
import {
  buildRagQuery,
  containsRagContext,
  injectRagContext,
  ragBlockForDelivery,
  type QueryPrefix,
} from "./src/memory/rag-injection.ts";
import { runDailySweep } from "./src/memory/sweep.ts";
import type { SemanticSearchDependencies } from "./src/memory/service.ts";
import { MemoryNodeService } from "./src/memory/service.ts";
import { SqliteVectorIndex } from "./src/memory/vector-index.ts";
import {
  registerMemoryCommands,
  registerMemoryTools,
} from "./src/tools/memory-tools.ts";

/** Request-local RAG result cached for one user turn within a session. */
interface RagSessionState {
  userIndex: number;
  query: string;
  context: Promise<string>;
  text?: string;
}

/**
 * Pi-facing composition root for the pi-friend-memory extension.
 *
 * Lifecycle hooks and memory tools will be registered here. The temporary
 * command keeps package loading independently testable while storage and
 * retrieval are still being designed.
 */
export default async function registerPiFriend(
  pi: ExtensionAPI,
): Promise<void> {
  // The memory service is session-scoped and shared by all memory tools.
  let memoryService: MemoryNodeService | undefined;
  let semanticSearch: SemanticSearchDependencies | undefined;
  let externalIndexManager: ExternalIndexManager | undefined;
  const ragSessions = new Map<string, RagSessionState>();
  let injectionConfig = defaultRagInjectionConfig();
  let queryPrefixes: readonly QueryPrefix[] = [];
  // The last injection this session produced, for the memory_last_rag tool.
  let lastRetrieval:
    | { diagnostics: RagRetrievalDiagnostics; at: string }
    | undefined;
  let autoCaptureConfig: AutoCaptureConfig = defaultAutoCaptureConfig();
  let captureScheduler: AutoCaptureScheduler | undefined;
  let sweepConfig: SweepConfig = defaultSweepConfig();
  let mergeConfig: MergeConfig = defaultMergeConfig();
  let dreamingConfig: DreamingConfig = defaultDreamingConfig();
  let sweepInFlight = false;
  let backgroundSweepTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundSweep: Promise<void> | undefined;
  let sweepAbortController: AbortController | undefined;
  let toolPrefix = DEFAULT_MEMORY_TOOL_PREFIX;

  // Tools must be registered before session_start. Load the prefix here and
  // repeat the full validation in session_start, where startup errors can be
  // reported through Pi's UI.
  try {
    toolPrefix = (await loadMemoryConfig()).toolPrefix;
  } catch {
    // The session_start handler reports the actionable configuration error.
  }

  // Temporary opt-in instrumentation for inspecting Pi's lifecycle payloads.
  registerHookLogging(pi);
  registerMemoryTools(pi, () => memoryService, toolPrefix, () => lastRetrieval);
  registerMemoryCommands(pi, () => lastRetrieval, toolPrefix, () => memoryService);

  /** Runs one transcript capture and advances the cursor on success. */
  const executeCapture = async (
    ctx: ExtensionContext,
    service: MemoryNodeService,
    config: AutoCaptureConfig,
  ): Promise<void> => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const statePath = captureStatePath();
      // One cursor per session, read fresh on every capture: several sessions
      // run at once and a house switches between them, so a process-wide
      // variable would let one session's position answer for another's. A
      // reload, resume or restart used to re-read the whole branch and stage
      // the same material twice; the file makes that read continue instead of
      // repeat.
      const restored = await readCaptureCursor(statePath, sessionId);
      if (restored.warning !== undefined) {
        reportCaptureWarning(
          ctx,
          `pi-friend auto-capture: ${restored.warning}`,
        );
      }
      const cursor = restored.cursor?.lastEntryId;

      const branch = ctx.sessionManager.getBranch();
      // A known cursor is exact. An unknown one is bounded to the most recent
      // turns rather than to the whole session: the previous capture almost
      // certainly covered the older material, and the 24,000-character cap
      // would drop it anyway — after paying to send it.
      const { startIndex, cursorFound } = captureStartIndex(
        branch,
        cursor,
        config.everyTurns,
      );
      if (cursor !== undefined && !cursorFound) {
        reportCaptureWarning(
          ctx,
          "pi-friend auto-capture: the saved capture cursor is not in this session branch; capturing only the most recent turns.",
        );
      }
      const entries = branch.slice(startIndex);
      // One call yields the transcript and the names it can support: the
      // transcript is bounded, so a hint gathered from the whole window could
      // name a person whose message was dropped from it.
      const { transcript, names } = buildCaptureWindow(entries);
      if (transcript.trim() === "") {
        return;
      }

      const drafts = await runCaptureModel(
        ctx,
        config,
        transcript,
        { names },
        (message) => reportCaptureWarning(ctx, message),
      );
      for (const draft of drafts) {
        await service.stageCandidate({
          title: draft.title,
          type: draft.type,
          body: draft.body,
          speaker: draft.speaker,
          agents: draft.agents,
          emotionalFlavour: draft.emotionalFlavour,
          tags: draft.tags,
          links: draft.links,
          source:
            draft.source ??
            `session:${ctx.sessionManager.getSessionId()}`,
        });
      }

      const finalEntry = branch[branch.length - 1];
      if (finalEntry) {
        await writeCaptureCursor(statePath, sessionId, {
          lastEntryId: finalEntry.id,
          lastCapturedAt: new Date().toISOString(),
        }).catch((error: unknown) => {
          reportCaptureWarning(
            ctx,
            `pi-friend auto-capture: could not save the capture cursor (${
              formatErrorChain(error)
            }).`,
          );
        });
      }
      debugRag("capture", {
        candidates: drafts.length,
      });
    } catch (error) {
      logError("auto-capture", error);
      debugRag("capture-failed", { error });
      // A rejected reply is already in the log with the model's text; saying so
      // turns an unexplained warning into a place to look.
      const where =
        error instanceof CaptureResponseError
          ? ` The model's reply was written to ${resolveDebugLogPath()}.`
          : "";
      reportCaptureWarning(
        ctx,
        `pi-friend auto-capture failed: ${formatErrorChain(error)}${where}`,
      );
    }
  };

  /**
   * Reports whether a session loaded now holds material its cursor has not passed.
   *
   * Derived, not stored. The cursor already records how far capture got, and the
   * branch is the authority on what has happened since; a flag written on every
   * message would be a second copy of that truth, able to lag behind it after a
   * failed write and to lie differently about which session it describes.
   *
   * An unknown cursor deliberately does not count. Its fallback re-reads the most
   * recent turns, which may already have been captured, and arming on every
   * resume would then stage duplicates each time a session is opened — so that
   * case stays with the next settle, where it has always belonged.
   */
  const hasUncapturedEntries = async (
    ctx: ExtensionContext,
    config: AutoCaptureConfig,
  ): Promise<boolean> => {
    const branch = ctx.sessionManager.getBranch();
    if (branch.length === 0) {
      return false;
    }
    const restored = await readCaptureCursor(
      captureStatePath(),
      ctx.sessionManager.getSessionId(),
    );
    const cursor = restored.cursor?.lastEntryId;
    const { startIndex, cursorFound } = captureStartIndex(
      branch,
      cursor,
      config.everyTurns,
    );
    if (cursor !== undefined && !cursorFound) {
      return false;
    }
    return buildCaptureWindow(branch.slice(startIndex)).transcript.trim() !== "";
  };

  /** Runs one sweep and reports its outcome without throwing to Pi hooks. */
  const executeSweep = async (
    ctx: ExtensionContext,
    service: MemoryNodeService,
    config: SweepConfig,
    dreaming: DreamingConfig,
    signal?: AbortSignal,
  ): Promise<void> => {
    try {
      const result = await runDailySweep(ctx, service, config, {
        dreaming,
        signal,
        reportWarning: (message) => reportCaptureWarning(ctx, message),
        reportError: (label, error) => logError(label, error),
      });
      debugRag("sweep", { ...result });
      if (result.error && !signal?.aborted) {
        reportCaptureWarning(
          ctx,
          `pi-friend daily sweep failed: ${result.error}`,
        );
      }
    } catch (error) {
      logError("daily sweep", error);
      debugRag("sweep-failed", { error });
      if (!signal?.aborted) {
        reportCaptureWarning(
          ctx,
          `pi-friend daily sweep failed: ${formatErrorChain(error)}`,
        );
      }
    }
  };

  /** Starts a sweep on the next task without delaying agent settlement. */
  const scheduleBackgroundSweep = (
    ctx: ExtensionContext,
    service: MemoryNodeService,
    config: SweepConfig,
    dreaming: DreamingConfig,
  ): void => {
    const controller = new AbortController();
    sweepAbortController = controller;
    backgroundSweepTimer = setTimeout(() => {
      backgroundSweepTimer = undefined;
      const tracked = executeSweep(
        ctx,
        service,
        config,
        dreaming,
        controller.signal,
      ).finally(() => {
        if (sweepAbortController === controller) {
          sweepAbortController = undefined;
        }
        backgroundSweep = undefined;
        sweepInFlight = false;
      });
      backgroundSweep = tracked;
    }, 0);
  };

  pi.on("session_start", async (_event, ctx) => {
    ragSessions.delete(ctx.sessionManager.getSessionId());
    try {
      await externalIndexManager?.stop();
      externalIndexManager = undefined;

      const repository = await MemoryNodeRepository.open();
      // Before anything parses a node. The spelling change is a hard failure on
      // either side of the rename, and this is the one moment where nothing has
      // read the store yet; a migration that ran later would be competing with
      // the error it exists to prevent.
      await reportMigrations(repository.store, ctx);
      injectionConfig = repository.store.config.injection;
      queryPrefixes = compileQueryPrefixes(
        repository.store.config.queryPrefixes.patterns,
      );
      autoCaptureConfig = repository.store.config.autoCapture;
      sweepConfig = repository.store.config.sweep;
      mergeConfig = repository.store.config.merge;
      dreamingConfig = repository.store.config.dreaming;
      const reportWarning = (message: string): void => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        } else {
          console.error(message);
        }
      };
      // Configuration problems that do not stop startup: unknown fields, or
      // prompt text naming vocabulary the parser cannot honour.
      for (const warning of repository.store.config.warnings) {
        reportWarning(`pi-friend memory configuration: ${warning}`);
      }
      semanticSearch = createSemanticSearch(repository, reportWarning);
      externalIndexManager = new ExternalIndexManager({
        indexPaths: repository.store.config.indexPaths,
        indexExclude: repository.store.config.indexExclude,
        memoryRoot: repository.store.root,
        semantic: semanticSearch,
        chunkSize: repository.store.config.vector.chunkSize,
        reportWarning,
        reportError: (label, error) => logError(label, error),
      });
      memoryService = new MemoryNodeService(
        repository,
        undefined,
        semanticSearch,
        externalIndexManager,
        createMergeWriter(ctx, mergeConfig, reportWarning),
      );
      await externalIndexManager.start();
      const service = memoryService;
      const config = autoCaptureConfig;
      captureScheduler?.shutdown();
      captureScheduler = new AutoCaptureScheduler({
        everyTurns: config.everyTurns,
        idleTimeoutMs: config.idleTimeout * 1_000,
        isIdle: () => ctx.isIdle(),
        capture: () => executeCapture(ctx, service, config),
        reportError: (label, error) => logError(label, error),
      });
      // A reload or resume lands here with the session's history already in the
      // branch, and nothing else will arm a capture until someone speaks. If the
      // cursor has not passed that history, arm the idle debounce now so the work
      // is captured even in a session nobody returns to.
      if (config.enabled && (await hasUncapturedEntries(ctx, config))) {
        captureScheduler.armIdleCapture();
      }
    } catch (error) {
      logError("memory initialization", error);
      const message = `pi-friend memory initialization failed: ${formatErrorChain(error)}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      } else {
        console.error(message);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    if (backgroundSweepTimer !== undefined) {
      clearTimeout(backgroundSweepTimer);
      backgroundSweepTimer = undefined;
      sweepInFlight = false;
    }
    sweepAbortController?.abort();
    await backgroundSweep;
    await externalIndexManager?.stop();
    externalIndexManager = undefined;
    sweepAbortController = undefined;
    memoryService = undefined;
    captureScheduler?.shutdown();
    captureScheduler = undefined;
    ragSessions.clear();
    semanticSearch?.index.close();
    semanticSearch = undefined;
    autoCaptureConfig = defaultAutoCaptureConfig();
    sweepConfig = defaultSweepConfig();
    dreamingConfig = defaultDreamingConfig();
    sweepInFlight = false;
  });

  pi.on("context", async (event, ctx) => {
    if (!memoryService || !injectionConfig.enabled) {
      debugRag("skipped", {
        hasService: memoryService !== undefined,
        enabled: injectionConfig.enabled,
      });
      return;
    }

    const ragQuery = buildRagQuery(event.messages, queryPrefixes);
    if (!ragQuery) {
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    let state = ragSessions.get(sessionId);
    if (
      state?.userIndex !== ragQuery.userIndex ||
      state.query !== ragQuery.query
    ) {
      const service = memoryService;
      state = {
        userIndex: ragQuery.userIndex,
        query: ragQuery.query,
        context: buildRagContext(
          service,
          ragQuery.query,
          injectionConfig,
          {
            reportError: (label, error) => logError(label, error),
          },
        )
          .then((rag) => {
            lastRetrieval = {
              diagnostics: rag.diagnostics,
              at: new Date().toISOString(),
            };
            debugRag("retrieved", {
              rawQuery: ragQuery.query,
              userPromptChars: ragQuery.userPrompt.length,
              assistantTextChars: ragQuery.assistantText?.length ?? 0,
              contextChars: rag.text.length,
              ...rag.diagnostics,
            });
            return rag.text;
          })
          .catch((error: unknown) => {
            logError("RAG context", error);
            debugRag("failed", { error });
            return "";
          }),
      };
      ragSessions.set(sessionId, state);
    }

    const retrievedText = await state.context;
    const contextText = ragBlockForDelivery(
      retrievedText,
      isDebugEnabled(),
    );
    state.text = contextText;
    if (contextText === "") {
      return;
    }

    debugRag("injected", {
      contextChars: contextText.length,
      emptyDebugBlock: retrievedText === "",
      position: injectionConfig.position,
    });
    return {
      messages: injectRagContext(
        event.messages,
        contextText,
        injectionConfig.position,
      ),
    };
  });

  pi.on("context_with_system", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = ragSessions.get(sessionId);
    if (!state?.text) {
      return;
    }
    debugRag(
      containsRagContext(event.messages, state.text)
        ? "delivery-confirmed"
        : "delivery-failed",
      {
        sessionId,
        userIndex: state.userIndex,
        contextChars: state.text.length,
      },
    );
  });

  pi.on("agent_settled", async (event, ctx) => {
    ragSessions.delete(ctx.sessionManager.getSessionId());
    if (
      event.aborted ||
      !memoryService ||
      !autoCaptureConfig.enabled ||
      !captureScheduler
    ) {
      return;
    }
    await captureScheduler.onSettled();
  });

  pi.on("agent_settled", (event, ctx) => {
    if (
      event.aborted ||
      sweepInFlight ||
      !memoryService ||
      !sweepConfig.enabled
    ) {
      return;
    }
    sweepInFlight = true;
    const service = memoryService;
    const config = { ...sweepConfig };
    const dreaming = { ...dreamingConfig };
    if (config.background) {
      scheduleBackgroundSweep(ctx, service, config, dreaming);
      return;
    }

    const controller = new AbortController();
    sweepAbortController = controller;
    return executeSweep(ctx, service, config, dreaming, controller.signal)
      .finally(() => {
        if (sweepAbortController === controller) {
          sweepAbortController = undefined;
        }
        sweepInFlight = false;
      });
  });

  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      // An empty argument should still produce a friendly greeting.
      const recipient = name?.trim() || "world";

      ctx.ui.notify(`Hello, ${recipient}!`, "info");
    },
  });
}

/** Creates semantic search when a stored OpenRouter key is available. */
function createSemanticSearch(
  repository: MemoryNodeRepository,
  reportWarning: (message: string) => void,
): SemanticSearchDependencies | undefined {
  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) {
    return undefined;
  }

  try {
    const configuredModel = repository.store.config.embeddings.model;
    const model = configuredModel.startsWith("openrouter/")
      ? configuredModel.slice("openrouter/".length)
      : configuredModel;
    const provider = new OpenRouterEmbeddingProvider({ apiKey, model });
    const index = SqliteVectorIndex.open({
      databasePath: path.join(repository.store.paths.index, "vectors.sqlite"),
      model: provider.model,
      dimensions: provider.dimensions,
    });
    if (index.rebuilt) {
      reportWarning(
        "pi-friend semantic index was discarded and is being rebuilt: its schema or embedding model changed. Every entry will be embedded again.",
      );
    }
    return { provider, index };
  } catch (error) {
    logError("semantic index initialization", error);
    reportWarning(
      `pi-friend semantic index unavailable: ${formatErrorChain(error)}`,
    );
    return undefined;
  }
}

/**
 * Runs pending store migrations and says what happened.
 *
 * Rewriting the memory store is not something to do quietly: the message names
 * how many files changed and where the pre-migration copy is. A migration that
 * nobody notices is only slightly better than one that fails.
 */
async function reportMigrations(
  store: MemoryStore,
  ctx: ExtensionContext,
): Promise<void> {
  const notify = (message: string, level: "info" | "warning" | "error") => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    } else {
      console.error(message);
    }
  };

  let outcome;
  try {
    outcome = await runPendingMigrations(store);
  } catch (error) {
    logError("memory migration", error);
    notify(
      `pi-friend memory migration failed: ${formatErrorChain(error)}`,
      "error",
    );
    return;
  }
  if (outcome === null) {
    return;
  }

  const skipped = outcome.skipped.length;
  const skippedNote =
    skipped === 0
      ? ""
      : ` ${skipped} file${skipped === 1 ? "" : "s"} could not be parsed and ${
          skipped === 1 ? "was" : "were"
        } left untouched (${outcome.skipped
          .slice(0, 3)
          .map((entry) => entry.path)
          .join(", ")}${skipped > 3 ? ", …" : ""}).`;

  if (outcome.status === "applied") {
    if (outcome.changed.length === 0 && skipped === 0) {
      return;
    }
    notify(
      `pi-friend memory: renamed emotional_flavor to emotional_flavour in ${outcome.changed.length} of ${outcome.scanned} files. A copy from before the migration is at ${outcome.backupPath ?? "(unknown)"}.${skippedNote}`,
      skipped === 0 ? "info" : "warning",
    );
    return;
  }

  if (outcome.status === "retired-backup") {
    notify(
      "pi-friend memory: the pre-migration copy was removed after a clean check of the store.",
      "info",
    );
    return;
  }

  if (outcome.status === "already-applied" && skipped > 0) {
    notify(
      `pi-friend memory: ${skipped} stored file${skipped === 1 ? "" : "s"} could not be parsed, so the pre-migration copy at ${outcome.backupPath ?? "(unknown)"} has been kept.${skippedNote}`,
      "warning",
    );
  }
}

/** Emits opt-in diagnostics for the retrieval and injection pipeline. */function debugRag(label: string, value: Record<string, unknown>): void {
  debugLog(`rag ${label}`, value);
}

/** Reports capture-model configuration issues without interrupting the session. */
function reportCaptureWarning(
  ctx: ExtensionContext,
  message: string,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    console.error(message);
  }
}
