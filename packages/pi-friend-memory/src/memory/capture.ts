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
import {
  defaultSpeakerTagPatterns,
  findSpeakerTag,
  type CompiledSpeakerTagPattern,
} from "./speaker-tags.ts";

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

/** What the window's own messages say about who was speaking. */
export interface CaptureSpeakerHint {
  /**
   * Distinct names signing person-authored messages, in the order they first
   * appear. Empty when nothing was signed: the capture then has no grounds for
   * attribution, and the prompt tells the model to omit rather than guess.
   */
  names: string[];
}

/** Builds the user-facing JSON extraction prompt. */
export function buildCapturePrompt(
  transcript: string,
  maxCandidates: number,
  speakerHint?: CaptureSpeakerHint,
): string {
  return [
    `Extract at most ${maxCandidates} durable memory candidates from the transcript below.`,
    ...speakerAttributionLines(speakerHint),
    'Use this JSON shape: {"candidates":[{"title":"string","type":"fact|preference|event|person-note","body":"concise Markdown","speaker":[{"name":"string","confident":true,"note":"optional"}],"agents":["string"],"emotional_flavor":"neutral","tags":[],"links":[]}]}',
    'Return {"candidates":[]} when nothing durable was learned.',
    "",
    "<transcript>",
    transcript,
    "</transcript>",
  ].join("\n");
}

/**
 * States who was speaking, in the terms the window supports.
 *
 * One name is a fact and is given as one; several names are also a fact, and
 * saying "the current speaker is X" then would attribute the earlier person's
 * words to the later one. Nothing at all is silence: the system prompt already
 * forbids inventing a name, and a guess here would be repeated across every
 * candidate in the batch.
 */
function speakerAttributionLines(hint?: CaptureSpeakerHint): string[] {
  const names = hint?.names ?? [];
  if (names.length === 0) {
    return [];
  }
  if (names.length === 1) {
    return [
      `The human speaker is ${names[0]}; use that concrete attribution name.`,
    ];
  }
  return [
    `More than one person is speaking: ${names.join(", ")}. Attribute each candidate to the person whose message it comes from.`,
  ];
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
  speakerHint?: CaptureSpeakerHint,
): CaptureCandidateDraft[] {
  const object = extractJsonObject(response);
  if (!object || !Array.isArray(object.candidates)) {
    throw new Error("Capture response must contain a candidates array.");
  }

  // A generic label is replaced only when exactly one person signed the window:
  // with several names in play there is no safe answer. The label is removed in
  // that case rather than guessed at, and the candidate is kept — an unidentified
  // speaker is a gap in the record, not a reason to lose the memory.
  const soleSpeaker =
    speakerHint?.names.length === 1 ? speakerHint.names[0] : undefined;

  return object.candidates
    .slice(0, maxCandidates)
    .map((candidate) => parseCandidate(candidate, soleSpeaker))
    .map((candidate) => ({
      ...candidate,
      speaker: attributeSpeakers(candidate.speaker),
    }))
    .filter((candidate) => !isQuarantinedMemoryType(candidate.type));
}

/**
 * Removes generic labels and folds repeated names into one record.
 *
 * A candidate whose speakers are all generic ends up with an empty list, which
 * is the honest record: nobody identifiable was named. Dropping the candidate
 * instead would lose a durable fact for the absence of a name, and the loss
 * would look like "nothing was worth remembering".
 */
function attributeSpeakers(speakers: MemorySpeaker[]): MemorySpeaker[] {
  const attributed: MemorySpeaker[] = [];
  for (const speaker of speakers) {
    if (isGenericSpeakerName(speaker.name)) {
      continue;
    }
    const existing = attributed.findIndex(
      (candidate) => candidate.name.toLowerCase() === speaker.name.toLowerCase(),
    );
    if (existing < 0) {
      attributed.push(speaker);
      continue;
    }
    // A later confident claim upgrades an uncertain one; otherwise the first
    // spelling and its note stand.
    if (!attributed[existing].confident && speaker.confident) {
      attributed[existing] = { ...attributed[existing], confident: true };
    }
  }
  return attributed;
}

/**
 * Reads the names written into the window's own messages.
 *
 * Only tags count. The previous mechanism inferred a name from first-person
 * phrasing, with a case-insensitive `[A-Z]`, so any word after "I am" became a
 * name: "I am so tired" supplied "so", and the parser then stamped it onto every
 * candidate in the batch. A tag is a name a person wrote on purpose, and the
 * same recogniser is used for query cleaning and the `speaker` index.
 */
export function captureSpeakerHint(
  entries: SessionEntry[],
  patterns: readonly CompiledSpeakerTagPattern[] = defaultSpeakerTagPatterns(),
): CaptureSpeakerHint {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const tag = findSpeakerTag(formatContent(entry.message.content), patterns);
    if (tag === undefined) {
      continue;
    }
    // `Aria` and `aria` are the same person; first spelling wins.
    const key = tag.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(tag.name);
  }
  return { names };
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
