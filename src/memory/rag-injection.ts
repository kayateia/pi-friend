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

/**
 * Appends one memory block to a selected user message.
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
          content: `${target.content}\n\n${block}`,
        }
      : {
          ...target,
          content: [...target.content, { type: "text", text: block }],
        };
  return updatedMessages;
}
