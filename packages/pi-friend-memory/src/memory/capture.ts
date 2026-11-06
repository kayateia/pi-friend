/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  MEMORY_TYPES,
  isQuarantinedMemoryType,
  type MemorySpeaker,
  type MemoryType,
} from "./schema.ts";

type AgentMessage = Extract<SessionEntry, { type: "message" }>["message"];

/** One candidate produced by the auto-capture model. */
export interface CaptureCandidateDraft {
  title: string;
  type: MemoryType;
  body: string;
  speaker: MemorySpeaker[];
  agents?: string[];
  emotionalFlavor?: string;
  tags?: string[];
  links?: string[];
  source?: string;
}

/** Builds the user-facing JSON extraction prompt. */
export function buildCapturePrompt(
  transcript: string,
  maxCandidates: number,
  speakerHint?: string,
): string {
  return [
    `Extract at most ${maxCandidates} durable memory candidates from the transcript below.`,
    ...(speakerHint
      ? [`The current human speaker is ${speakerHint}; use that concrete attribution name.`]
      : []),
    'Use this JSON shape: {"candidates":[{"title":"string","type":"fact|preference|event|person-note","body":"concise Markdown","speaker":[{"name":"string","confident":true}],"agents":[],"emotional_flavor":"neutral","tags":[],"links":[]}]}',
    'Return {"candidates":[]} when nothing durable was learned.',
    "",
    "<transcript>",
    transcript,
    "</transcript>",
  ].join("\n");
}

/** Serializes recent session entries into a bounded capture transcript. */
export function serializeCaptureTranscript(
  entries: SessionEntry[],
  maxChars = 24_000,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const text = formatAgentMessage(entry.message);
      if (text) lines.push(text);
    } else if (entry.type === "custom_message") {
      const text = formatContent(entry.content);
      if (text) lines.push(`CUSTOM: ${text}`);
    }
  }

  const joined = lines.join("\n\n");
  return joined.length <= maxChars
    ? joined
    : joined.slice(joined.length - maxChars);
}

/**
 * Returns the index where the most recent `turns` user turns begin.
 *
 * Capture normally resumes from a persisted cursor, which is exact. When the
 * cursor is missing, belongs to another session, or names an entry that is no
 * longer in the branch, reading from the start of the session is the wrong
 * default: it re-sends material that was almost certainly captured already, and
 * the transcript cap then silently keeps only its tail. Taking the most recent
 * turns is what the cursor would have delimited in the normal case, and it
 * bounds the cost of an unknown cursor to one capture cycle.
 *
 * `turns` is counted in user messages rather than in Pi agent runs: the user
 * message is the unit a person would recognise, and a turn with ten tool calls
 * is still one thing that was said.
 */
export function recentTurnStart(
  entries: SessionEntry[],
  turns: number,
): number {
  if (!Number.isInteger(turns) || turns < 1) {
    return 0;
  }
  let seen = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message.role === "user") {
      seen += 1;
      if (seen >= turns) {
        return index;
      }
    }
  }
  return 0;
}

/**
 * Returns where a capture begins reading, and whether the cursor was usable.
 *
 * A cursor naming an entry in the branch is exact, and the read starts after it.
 * A cursor naming nothing — compacted away, or recorded against a branch that is
 * no longer the leaf — is ambiguous, so the bounded recent-turn window is the
 * fallback. `cursorFound` lets the caller warn about exactly that case without
 * treating a session that has never been captured as an anomaly.
 */
export function captureStartIndex(
  entries: SessionEntry[],
  cursor: string | undefined,
  everyTurns: number,
): { startIndex: number; cursorFound: boolean } {
  if (cursor !== undefined) {
    const index = entries.findIndex((entry) => entry.id === cursor);
    if (index >= 0) {
      return { startIndex: index + 1, cursorFound: true };
    }
  }
  return { startIndex: recentTurnStart(entries, everyTurns), cursorFound: false };
}

/** Parses the capture model's JSON response into validated draft objects. */
export function parseCaptureResponse(
  response: string,
  maxCandidates: number,
  speakerHint?: string,
): CaptureCandidateDraft[] {
  const object = extractJsonObject(response);
  if (!object || !Array.isArray(object.candidates)) {
    throw new Error("Capture response must contain a candidates array.");
  }

  return object.candidates
    .slice(0, maxCandidates)
    .map((candidate) => parseCandidate(candidate, speakerHint))
    .filter(
      (candidate) =>
        !isQuarantinedMemoryType(candidate.type) &&
        candidate.speaker.every(
          (speaker) => !isGenericSpeakerName(speaker.name),
        ),
    );
}

/** Infers an explicit human name from simple first-person introduction forms. */
export function inferSpeakerName(transcript: string): string | undefined {
  const patterns = [
    /\bmy name is ([A-Z][\p{L}\p{N}_-]{0,30})\b/iu,
    /\bi am ([A-Z][\p{L}\p{N}_-]{0,30})\b/iu,
    /\bi['’]m ([A-Z][\p{L}\p{N}_-]{0,30})\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(transcript);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

/** Formats one agent message without retaining images or full tool payloads. */
function formatAgentMessage(message: AgentMessage): string | null {
  switch (message.role) {
    case "user": {
      const content = formatContent(message.content);
      return content ? `USER: ${content}` : null;
    }
    case "assistant": {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim() !== "") {
          parts.push(block.text);
        } else if (block.type === "toolCall") {
          parts.push(`[tool call: ${block.name}]`);
        }
      }
      return parts.length > 0 ? `ASSISTANT: ${parts.join("\n")}` : null;
    }
    case "toolResult": {
      const content = formatContent(message.content);
      return content ? `TOOL ${message.toolName}: ${content}` : null;
    }
    case "system":
      return null;
    default:
      return null;
  }
}

/** Extracts text from Pi content arrays while omitting binary image data. */
function formatContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return [block.text.trim()];
      }
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

/** Extracts one JSON object from plain text or a fenced code block. */
function extractJsonObject(
  response: string,
): Record<string, unknown> | null {
  const first = response.indexOf("{");
  const last = response.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(response.slice(first, last + 1));
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

/** Parses and validates one candidate object. */
function parseCandidate(
  value: unknown,
  speakerHint: string | undefined,
): CaptureCandidateDraft {
  if (!isRecord(value)) {
    throw new Error("Capture candidate must be an object.");
  }
  const title = requireString(value.title, "title");
  const body = requireString(value.body, "body");
  if (!isMemoryType(value.type)) {
    throw new Error("Capture candidate has an invalid type.");
  }
  if (!Array.isArray(value.speaker)) {
    throw new Error("Capture candidate speaker must be an array.");
  }
  const agents = optionalStringArray(value.agents, "agents");
  const tags = optionalStringArray(value.tags, "tags");
  const links = optionalStringArray(value.links, "links");

  return {
    title,
    type: value.type,
    body,
    speaker: value.speaker.map((speaker, index) => {
      if (!isRecord(speaker)) {
        throw new Error(`Capture speaker ${index} must be an object.`);
      }
      if (typeof speaker.confident !== "boolean") {
        throw new Error(`Capture speaker ${index} confident must be boolean.`);
      }
      return {
        name:
          isGenericSpeakerName(
            requireString(speaker.name, `speaker[${index}].name`),
          ) && speakerHint
            ? speakerHint
            : requireString(speaker.name, `speaker[${index}].name`),
        confident: speaker.confident,
        ...(typeof speaker.note === "string"
          ? { note: speaker.note }
          : {}),
      };
    }),
    ...(agents === undefined ? {} : { agents }),
    ...(value.emotional_flavor === undefined
      ? {}
      : {
          emotionalFlavor: requireString(
            value.emotional_flavor,
            "emotional_flavor",
          ),
        }),
    ...(tags === undefined ? {} : { tags }),
    ...(links === undefined ? {} : { links }),
    ...(value.source === undefined
      ? {}
      : { source: requireString(value.source, "source") }),
  };
}

/** Requires a non-empty string. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Capture candidate ${field} must be a non-empty string.`);
  }
  return value.trim();
}

/** Parses an optional string array. */
function optionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Capture candidate ${field} must be a string array.`);
  }
  return value;
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows an unknown candidate type to an approved memory type. */
function isMemoryType(value: unknown): value is MemoryType {
  return (
    typeof value === "string" &&
    MEMORY_TYPES.some((type) => type === value)
  );
}

/** Rejects generic role labels masquerading as attribution names. */
function isGenericSpeakerName(name: string): boolean {
  return [
    "user",
    "assistant",
    "system",
    "unknown",
    "the user",
  ].includes(name.trim().toLowerCase());
}
