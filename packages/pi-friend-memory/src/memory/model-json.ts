/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { jsonrepair } from "jsonrepair";

/**
 * What one model reply yielded, and what it cost to read.
 *
 * A reply that had to be repaired is still a reply: the repairs are local,
 * syntax-level, and the object that comes back is the one the model meant to
 * write. Callers keep their own validation, so a body damaged beyond use fails
 * a schema check rather than arriving quietly.
 */
export interface ModelJsonReading {
  /** The object the reply contains, when one could be read. */
  object?: Record<string, unknown>;
  /** One clause naming why no object could be read, phrased to follow "response". */
  problem?: string;
  /** Whether the text had to be repaired before it would parse. */
  repaired: boolean;
}

/**
 * Reads the one JSON object a model reply is supposed to contain.
 *
 * Every prompt in this extension asks for a JSON object, and models return it
 * wrapped in prose, in a fenced block, or with the occasional syntax slip —
 * most often a bare `"` inside a string body that should have been escaped.
 * Strict parsing rejects the whole reply for one of those, which used to cost
 * an entire capture window, sweep pass, or merge rewrite.
 *
 * The object is taken from the first `{` to the last `}`, so surrounding prose
 * and fences need no trimming. It is parsed strictly first, and only a reply
 * that fails is handed to `jsonrepair`, which walks the text character by
 * character and fixes unescaped quotes, missing or trailing commas, single
 * quotes and similar slips while leaving the content alone. A reply that parses
 * strictly is never rewritten.
 *
 * When a repair succeeds the optional `reportWarning` hears about it: a repair
 * is a fact about the model's output that a person may want to see, and the one
 * that failed without it costs a whole window. When both parses fail, `problem`
 * carries the strict parser's message, which names the position of the fault.
 */
export function readModelJson(
  response: string,
  reportWarning?: (message: string) => void,
): ModelJsonReading {
  const reading = readDelimited(response, "{", "}", "object", reportWarning);
  if (reading.value === undefined) {
    return { repaired: reading.repaired, problem: reading.problem };
  }
  return isRecord(reading.value)
    ? { object: reading.value, repaired: reading.repaired }
    : { repaired: reading.repaired, problem: "is not a JSON object" };
}

/** What a reply yielded when an array was asked for. */
export interface ModelJsonArrayReading {
  /** The array the reply contains, when one could be read. */
  value?: unknown[];
  /** One clause naming why no array could be read, phrased to follow "response". */
  problem?: string;
  /** Whether the text had to be repaired before it would parse. */
  repaired: boolean;
}

/**
 * Reads the one JSON array a model reply is supposed to contain.
 *
 * Same reader as `readModelJson`, delimited by brackets instead of braces, for
 * the prompts that ask for a bare array — the capture type retry is the only
 * one, and it wants a list of type names with no wrapper around them.
 */
export function readModelJsonArray(
  response: string,
  reportWarning?: (message: string) => void,
): ModelJsonArrayReading {
  const reading = readDelimited(response, "[", "]", "array", reportWarning);
  if (reading.value === undefined) {
    return { repaired: reading.repaired, problem: reading.problem };
  }
  return Array.isArray(reading.value)
    ? { value: reading.value, repaired: reading.repaired }
    : { repaired: reading.repaired, problem: "is not a JSON array" };
}

/** One delimited JSON value read out of a reply, before any shape check. */
interface DelimitedReading {
  value?: unknown;
  problem?: string;
  repaired: boolean;
}

/**
 * Reads the JSON value between the first `open` and the last `close`.
 *
 * Prose and fences need no trimming because the delimiters bracket the value.
 * The parse is strict first, and only a text that fails is handed to
 * `jsonrepair`, so a well-formed reply is never rewritten.
 */
function readDelimited(
  response: string,
  open: string,
  close: string,
  kind: string,
  reportWarning?: (message: string) => void,
): DelimitedReading {
  const first = response.indexOf(open);
  const last = response.lastIndexOf(close);
  if (first < 0 || last <= first) {
    return { repaired: false, problem: `does not contain a JSON ${kind}` };
  }

  const text = response.slice(first, last + 1);
  let strictProblem: string;
  try {
    return { value: JSON.parse(text) as unknown, repaired: false };
  } catch (error) {
    strictProblem = describeParseError(error);
  }

  let repaired: string;
  try {
    repaired = jsonrepair(text);
  } catch {
    return { repaired: true, problem: `is not valid JSON (${strictProblem})` };
  }

  try {
    const value: unknown = JSON.parse(repaired);
    reportWarning?.(
      `the model's reply was not valid JSON (${strictProblem}) and was repaired before use`,
    );
    return { value, repaired: true };
  } catch {
    return { repaired: true, problem: `is not valid JSON (${strictProblem})` };
  }
}

/** Renders a parse failure as one clause, keeping the parser's position. */
function describeParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
