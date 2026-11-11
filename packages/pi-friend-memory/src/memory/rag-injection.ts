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

/** Query text assembled from current user and preceding assistant prose. */
export interface RagQuery {
  userIndex: number;
  userPrompt: string;
  assistantText?: string;
  query: string;
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

/**
 * The local time a sibling extension prefixes to person-authored messages.
 *
 * Mirrors `pi-time-awareness`'s `TIMESTAMP_PREFIX_PATTERN`: the text arrives
 * through `context`, so a name tag behind it is no longer at the start of the
 * message. It is stripped for the query only; nothing rewrites the transcript.
 * The format is that extension's, so it needs revising if that changes.
 */
/** One configured prefix, compiled once and applied to every line. */
export interface QueryPrefix {
  readonly source: string;
  readonly regex: RegExp;
}

/**
 * Removes configured prefixes from the start of each line.
 *
 * What a deployment puts in front of a person's words is that deployment's
 * business — a timestamp here, a channel name there — so the shapes are
 * configuration rather than a pattern this extension knows. A prefix is markup
 * and must not reach matching, an embedding or the access log.
 */
function withoutPrefixes(text: string, prefixes: readonly QueryPrefix[]): string {
  if (prefixes.length === 0) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => {
      let stripped = line;
      for (const prefix of prefixes) {
        stripped = stripped.replace(prefix.regex, "");
      }
      return stripped;
    })
    .join("\n")
    .trim();
}

/**
 * Builds the RAG query from the latest user turn and the most recent visible
 * assistant prose before it. Thinking blocks, tool calls, and tool results are
 * deliberately excluded.
 */
export function buildRagQuery(
  messages: RagAgentMessage[],
  prefixes: readonly QueryPrefix[] = [],
): RagQuery | undefined {
  const latest = latestUserPrompt(messages);
  if (!latest) {
    return undefined;
  }

  let assistantText: string | undefined;
  for (let index = latest.index - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (text !== "") {
      assistantText = text;
      break;
    }
  }

  const userPrompt = withoutPrefixes(latest.prompt, prefixes);
  return {
    userIndex: latest.index,
    userPrompt: latest.prompt,
    ...(assistantText === undefined ? {} : { assistantText }),
    query:
      assistantText === undefined
        ? userPrompt
        : `${assistantText}\n\n${userPrompt}`,
  };
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
 * Position 0 targets the current user turn; position -1 is one prompt back,
 * -2 two back, and so on. A position deeper than the transcript clamps to the
 * earliest user turn that exists: the intended target is not there, and the
 * nearest one that is sits at the start of the conversation. A position that
 * is not zero or a negative integer is treated as 0.
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
    Number.isInteger(position) && position <= 0 ? position : 0;
  // A negative slot means the position reached past the start of the
  // transcript, so the earliest user turn is the closest one to it.
  const targetSlot = Math.max(0, userIndices.length - 1 + normalizedPosition);
  const requestedIndex = userIndices[targetSlot];
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
