/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** Agent message shape used by Pi's request-local context transform. */
export type RagAgentMessage = ContextEvent["messages"][number];

/** Empty marker injected during debug runs when retrieval selects no nodes. */
export const EMPTY_RAG_BLOCK =
  "<pi-friend-memory>\n</pi-friend-memory>";

/** Returns the requested RAG text or the debug-only empty marker. */
export function ragBlockForDelivery(
  text: string,
  includeEmpty: boolean,
): string {
  return text !== "" || !includeEmpty ? text : EMPTY_RAG_BLOCK;
}

/** Latest user prompt and its request-local message index. */
export interface LatestUserPrompt {
  index: number;
  prompt: string;
}

/**
 * Returns the latest non-empty user prompt from the visible context.
 *
 * Text and mixed image/text messages are supported without assuming that user
 * content is always a plain string.
 */
export function latestUserPrompt(
  messages: RagAgentMessage[],
): LatestUserPrompt | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    const prompt = messageText(message.content);
    if (prompt.trim() !== "") {
      return { index, prompt };
    }
  }
  return undefined;
}

/** Returns whether a user message contains a previously injected RAG block. */
export function containsRagContext(
  messages: RagAgentMessage[],
  block: string,
): boolean {
  const normalized = block.trim();
  if (normalized === "") {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === "user" &&
      messageText(message.content).includes(normalized),
  );
}

/**
 * Prepends one memory block to a selected user message.
 *
 * Position 0 targets the current user turn. Negative positions select earlier
 * user turns, falling back to the latest turn when the transcript is shorter.
 */
export function injectRagContext(
  messages: RagAgentMessage[],
  block: string,
  position: number,
): RagAgentMessage[] {
  if (block.trim() === "" || messages.length === 0) {
    return messages;
  }

  const userIndices = messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  if (userIndices.length === 0) {
    return messages;
  }

  const normalizedPosition =
    Number.isInteger(position) && position <= 0 ? position : -1;
  const requestedIndex =
    userIndices[userIndices.length - 1 + normalizedPosition] ??
    userIndices[userIndices.length - 1];
  if (requestedIndex === undefined) {
    return messages;
  }

  const target = messages[requestedIndex];
  if (!target || target.role !== "user") {
    return messages;
  }

  const updatedMessages = [...messages];
  updatedMessages[requestedIndex] =
    typeof target.content === "string"
      ? {
          ...target,
          content: `${block}\n\n${target.content}`,
        }
      : {
          ...target,
          content: [{ type: "text", text: block }, ...target.content],
        };
  return updatedMessages;
}

/** Extracts textual content from a user or custom message payload. */
function messageText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  return typeof content === "string"
    ? content
    : content
        .flatMap((block) =>
          block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n");
}
