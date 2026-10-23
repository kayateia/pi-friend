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
import { debugLog } from "./src/debug/log.ts";
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
import {
  OpenRouterEmbeddingProvider,
  resolveOpenRouterApiKey,
} from "./src/memory/embedding.ts";
import { MemoryNodeRepository } from "./src/memory/repository.ts";
import { buildRagContext } from "./src/memory/rag.ts";
import { injectRagContext } from "./src/memory/rag-injection.ts";
import { runDailySweep } from "./src/memory/sweep.ts";
import type { SemanticSearchDependencies } from "./src/memory/service.ts";
import { MemoryNodeService } from "./src/memory/service.ts";
import { SqliteVectorIndex } from "./src/memory/vector-index.ts";
import { registerMemoryTools } from "./src/tools/memory-tools.ts";

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
  let ragContext: string | undefined;
  let injectionConfig = defaultRagInjectionConfig();
  let autoCaptureConfig: AutoCaptureConfig = defaultAutoCaptureConfig();
  let settledRuns = 0;
  let captureCursor: string | undefined;
  let captureInFlight = false;
  let sweepConfig: SweepConfig = defaultSweepConfig();
  let dreamingConfig: DreamingConfig = defaultDreamingConfig();
  let sweepInFlight = false;
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      const repository = await MemoryNodeRepository.open();
      injectionConfig = repository.store.config.injection;
      autoCaptureConfig = repository.store.config.autoCapture;
      sweepConfig = repository.store.config.sweep;
      dreamingConfig = repository.store.config.dreaming;
      semanticSearch = createSemanticSearch(repository, (message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        } else {
          console.error(message);
        }
      });
      memoryService = new MemoryNodeService(
        repository,
        undefined,
        semanticSearch,
      );
    } catch (error) {
      const message = `pi-friend memory initialization failed: ${describeError(error)}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      } else {
        console.error(message);
      }
    }
  });

  pi.on("session_shutdown", () => {
    memoryService = undefined;
    ragContext = undefined;
    semanticSearch?.index.close();
    semanticSearch = undefined;
    autoCaptureConfig = defaultAutoCaptureConfig();
    settledRuns = 0;
    captureCursor = undefined;
    captureInFlight = false;
    sweepConfig = defaultSweepConfig();
    dreamingConfig = defaultDreamingConfig();
    sweepInFlight = false;
  });

  pi.on("before_agent_start", async (event) => {
    ragContext = undefined;
    if (
      !memoryService ||
      !injectionConfig.enabled ||
      event.messageType !== "user"
    ) {
      debugRag("skipped", {
        hasService: memoryService !== undefined,
        enabled: injectionConfig.enabled,
        messageType: event.messageType,
      });
      return;
    }

    try {
      ragContext = (
        await buildRagContext(
          memoryService,
          event.prompt,
          injectionConfig,
        )
      ).text || undefined;
      debugRag("retrieved", {
        contextChars: ragContext?.length ?? 0,
      });
    } catch (error) {
      debugRag("failed", { error: describeError(error) });
      // Retrieval enriches context but must never block the user's prompt.
    }
  });

  pi.on("context", (event) => {
    if (!ragContext) {
      return;
    }
    debugRag("injected", {
      contextChars: ragContext.length,
      position: injectionConfig.position,
    });
    return {
      messages: injectRagContext(
        event.messages,
        ragContext,
        injectionConfig.position,
      ),
    };
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (
      event.aborted ||
      captureInFlight ||
      !memoryService ||
      !autoCaptureConfig.enabled
    ) {
      return;
    }

    settledRuns += 1;
    if (settledRuns < autoCaptureConfig.everyTurns) {
      return;
    }
    settledRuns = 0;
    captureInFlight = true;

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

      const service = memoryService;
      const drafts = await runCaptureModel(
        ctx,
        autoCaptureConfig,
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
      debugRag("capture-failed", { error: describeError(error) });
    } finally {
      captureInFlight = false;
    }
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (
      event.aborted ||
      sweepInFlight ||
      !memoryService ||
      !sweepConfig.enabled
    ) {
      return;
    }
    sweepInFlight = true;
    try {
      const result = await runDailySweep(
        ctx,
        memoryService,
        sweepConfig,
        {
          dreaming: dreamingConfig,
          reportWarning: (message) =>
            reportCaptureWarning(ctx, message),
        },
      );
      debugRag("sweep", { ...result });
      if (result.error) {
        reportCaptureWarning(
          ctx,
          `pi-friend daily sweep failed: ${result.error}`,
        );
      }
    } finally {
      sweepInFlight = false;
    }
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
    const provider = new OpenRouterEmbeddingProvider({ apiKey });
    const index = SqliteVectorIndex.open({
      databasePath: path.join(repository.store.paths.index, "vectors.sqlite"),
      model: provider.model,
      dimensions: provider.dimensions,
    });
    return { provider, index };
  } catch (error) {
    reportWarning(
      `pi-friend semantic index unavailable: ${describeError(error)}`,
    );
    return undefined;
  }
}

/** Formats unknown thrown values for a user-visible initialization error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
