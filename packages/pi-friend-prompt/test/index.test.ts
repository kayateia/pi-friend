/**
 * pi-friend
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import registerPiFriendPrompt from "../index.ts";

type TestHandler = (event: unknown, context: unknown) => unknown;

test("prompt build failures warn and retry on every request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-friend-prompt-run-"));
  const configDirectory = path.join(directory, "pi-friend");
  const configPath = path.join(configDirectory, "pi-friend-prompt.yml");
  const promptFile = path.join(configDirectory, "missing.md");
  const logPath = path.join(configDirectory, "debug.log");
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousDebugHooks = process.env.PI_FRIEND_DEBUG_HOOKS;
  const previousDebugLog = process.env.PI_FRIEND_DEBUG_LOG;
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    configPath,
    [
      "prompt:",
      "  - section: preamble",
      "    action: replace",
      "    files: [missing.md]",
    ].join("\n"),
    "utf8",
  );
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_FRIEND_DEBUG_HOOKS = "1";
  process.env.PI_FRIEND_DEBUG_LOG = logPath;

  try {
    const harness = createPiHarness();
    const notifications: string[] = [];
    const context = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "test-session",
      },
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    } as unknown as ExtensionContext;

    await harness.before(createEvent(), context);
    await harness.before(createEvent(), context);
    assert.equal(notifications.length, 2);
    assert.match(notifications[0] ?? "", /pi-friend-prompt:/);
    assert.match(notifications[1] ?? "", /pi-friend-prompt:/);

    const debugLog = await readFile(logPath, "utf8");
    assert.equal(
      debugLog.match(/\[prompt build failed\]/gu)?.length,
      2,
    );
    assert.match(debugLog, /prompt\[0\]\.files\[0\]/u);
    assert.match(debugLog, /missing\.md/u);
    assert.match(debugLog, /ENOENT/u);

    await writeFile(promptFile, "Recovered prompt.", "utf8");
    const recoveredEvent = createEvent();
    await harness.before(recoveredEvent, context);

    assert.equal(notifications.length, 2);
    assert.equal(
      recoveredEvent.systemPromptOptions.customPrompt,
      "Recovered prompt.",
    );
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    if (previousDebugHooks === undefined) {
      delete process.env.PI_FRIEND_DEBUG_HOOKS;
    } else {
      process.env.PI_FRIEND_DEBUG_HOOKS = previousDebugHooks;
    }
    if (previousDebugLog === undefined) {
      delete process.env.PI_FRIEND_DEBUG_LOG;
    } else {
      process.env.PI_FRIEND_DEBUG_LOG = previousDebugLog;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

/** Captures the extension's before_agent_start handler. */
function createPiHarness(): { before: TestHandler } {
  const handlers = new Map<string, TestHandler>();
  const pi = {
    on(event: string, handler: TestHandler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  registerPiFriendPrompt(pi);

  const before = handlers.get("before_agent_start");
  if (before === undefined) {
    throw new Error("before_agent_start handler was not registered.");
  }
  return { before };
}

/** Builds a minimal event accepted by the before_agent_start handler. */
function createEvent(): BeforeAgentStartEvent {
  const systemPromptOptions: NormalizedBuildSystemPromptOptions = {
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools: ["read"],
    hiddenTools: [],
    toolSnippets: { read: "Read files." },
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    cwd: "/tmp",
    contextFiles: [],
    skills: [],
  };
  return {
    type: "before_agent_start",
    messageType: "user",
    systemPrompt: "",
    prompt: "hello",
    systemPromptOptions,
  };
}
