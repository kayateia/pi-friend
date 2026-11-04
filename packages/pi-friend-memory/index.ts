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
} from "./src/memory/config.ts";
import { serializeCaptureTranscript } from "./src/memory/capture.ts";
import { runCaptureModel } from "./src/memory/capture-runner.ts";
import { AutoCaptureScheduler } from "./src/memory/capture-scheduler.ts";
import {
  OpenRouterEmbeddingProvider,
  resolveOpenRouterApiKey,
} from "./src/memory/embedding.ts";
import { ExternalIndexManager } from "./src/memory/external-index-manager.ts";
import { MemoryNodeRepository } from "./src/memory/repository.ts";
import { buildRagContext } from "./src/memory/rag.ts";
import {
  buildRagQuery,
  containsRagContext,
  injectRagContext,
  ragBlockForDelivery,
} from "./src/memory/rag-injection.ts";
import { runDailySweep } from "./src/memory/sweep.ts";
import type { SemanticSearchDependencies } from "./src/memory/service.ts";
import { MemoryNodeService } from "./src/memory/service.ts";
import { SqliteVectorIndex } from "./src/memory/vector-index.ts";
import { registerMemoryTools } from "./src/tools/memory-tools.ts";

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
  let autoCaptureConfig: AutoCaptureConfig = defaultAutoCaptureConfig();
  let captureCursor: string | undefined;
  let captureScheduler: AutoCaptureScheduler | undefined;
  let sweepConfig: SweepConfig = defaultSweepConfig();
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
  registerMemoryTools(pi, () => memoryService, toolPrefix);

  /** Runs one transcript capture and advances the cursor on success. */
  const executeCapture = async (
    ctx: ExtensionContext,
    service: MemoryNodeService,
    config: AutoCaptureConfig,
  ): Promise<void> => {
    try {
      const branch = ctx.sessionManager.getBranch();
      const cursorIndex = captureCursor
        ? branch.findIndex((entry) => entry.id === captureCursor)
        : -1;
      const entries = branch.slice(cursorIndex + 1);
      const transcript = serializeCaptureTranscript(entries);
      if (transcript.trim() === "") {
        return;
      }

      const drafts = await runCaptureModel(
        ctx,
        config,
        transcript,
        (message) => reportCaptureWarning(ctx, message),
      );
      for (const draft of drafts) {
        await service.stageCandidate({
          title: draft.title,
          type: draft.type,
          body: draft.body,
          speaker: draft.speaker,
          agents: draft.agents,
          emotionalFlavor: draft.emotionalFlavor,
          tags: draft.tags,
          links: draft.links,
          source:
            draft.source ??
            `session:${ctx.sessionManager.getSessionId()}`,
        });
      }

      const finalEntry = branch[branch.length - 1];
      if (finalEntry) {
        captureCursor = finalEntry.id;
      }
      debugRag("capture", {
        candidates: drafts.length,
      });
    } catch (error) {
      logError("auto-capture", error);
      debugRag("capture-failed", { error });
      reportCaptureWarning(
        ctx,
        `pi-friend auto-capture failed: ${formatErrorChain(error)}`,
      );
    }
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
      injectionConfig = repository.store.config.injection;
      autoCaptureConfig = repository.store.config.autoCapture;
      sweepConfig = repository.store.config.sweep;
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
    captureCursor = undefined;
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

    const ragQuery = buildRagQuery(event.messages);
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
            debugRag("retrieved", {
              query: ragQuery.query,
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
    return { provider, index };
  } catch (error) {
    logError("semantic index initialization", error);
    reportWarning(
      `pi-friend semantic index unavailable: ${formatErrorChain(error)}`,
    );
    return undefined;
  }
}

/** Emits opt-in diagnostics for the retrieval and injection pipeline. */
function debugRag(label: string, value: Record<string, unknown>): void {
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
