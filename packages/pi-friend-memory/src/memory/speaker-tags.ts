/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recognises the forms a person uses to sign or head a message.
 *
 * One implementation serves every caller that needs to know "is this text a
 * speaker tag, and whose name is in it": stripping the tag from a search query,
 * hinting the capture model, and indexing `speaker` so attribution is
 * searchable. Two implementations would drift, and the drift would be invisible
 * — capture would attribute one way while search cleaned another.
 *
 * A tag is recognised only in the position its form allows. Prefix forms are
 * anchored at the start of the text and must be followed by whitespace or the
 * end; suffix forms sit at the end and must be preceded by whitespace or the
 * start. A `Name:` anywhere in prose is not a tag, and a bracket that is not
 * closed by the end of the opening word is not a name: those rules are what
 * keep "Note:", "TODO:" and a Markdown link's `[text]` from being mistaken for
 * attribution.
 */

/** One recognised tag: the name it carries, and the span it occupies. */
export interface SpeakerTag {
  /** The name exactly as written, with surrounding whitespace removed. */
  name: string;
  /** Offset of the tag's first visible character. */
  start: number;
  /** Offset just past the tag; the whitespace after it is not included. */
  end: number;
}

/** A pattern source and the RegExp compiled from it. */
export interface CompiledSpeakerTagPattern {
  readonly source: string;
  readonly regex: RegExp;
}

/** Raised when a configured pattern cannot be used as a tag recogniser. */
export class SpeakerTagPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeakerTagPatternError";
  }
}

/**
 * Longest pattern accepted from configuration.
 *
 * A pattern is evaluated against every message and every search query, so a
 * pathological one is a denial of service with good manners. The bound is far
 * above any real tag form and small enough that an absurd expression is a
 * configuration error rather than a stall.
 */
export const MAX_SPEAKER_TAG_PATTERN_LENGTH = 200;

/**
 * Name characters, shared by every default pattern.
 *
 * One word: letters in either case, apostrophes, hyphens anywhere a compound
 * may occur. No whitespace, so a prefix tag cannot swallow the start of the
 * message and a suffix tag cannot reach back over a phrase. No digits and no
 * periods, so a bracketed timestamp such as `[Mon 2026-11-02 16:31 EST]` and a
 * dotted hostname do not read as names.
 *
 * One word is a deliberate narrowing: plural systems generally sign with a
 * first name, a nickname or another contraction, and admitting spaces buys a
 * multi-word name at the cost of matches nobody meant. A house that signs with
 * full names can put its own patterns in `memory.speaker_tags.patterns`.
 */
const NAME = String.raw`[A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*`;

/**
 * The forms recognised when the configuration supplies none.
 *
 * Each is a complete regular expression whose first capture group is the name.
 * Order matters: the first pattern that matches in the first position wins, so
 * the more specific forms come first.
 *
 * The suffix form takes one trailing word, so prose that ends in a hyphenated
 * phrase cannot read as a signature: the word before the end has more prose
 * after it and the tag has to reach the end of the text.
 */
export const DEFAULT_SPEAKER_TAG_PATTERNS: readonly string[] = [
  // \>>Aria: — the form this house uses in pi-web messages.
  String.raw`^\s*\\>>\s*(${NAME})\s*:`,
  // <Aria> — bracketless angle form.
  String.raw`^\s*<(${NAME})>(?=\s|$)`,
  // Aria> — name then a single closing angle.
  String.raw`^\s*(${NAME})>(?=\s|$)`,
  // [Aria] — square-bracketed name.
  String.raw`^\s*\[(${NAME})\](?=\s|$)`,
  // A signature at the end: -Aria or ~Aria.
  String.raw`(?:^|\s)[-~](${NAME})\s*$`,
];

/** Compiles patterns once and reuses them for every message. */
const defaultPatterns = compileLazily(DEFAULT_SPEAKER_TAG_PATTERNS);

/**
 * Returns the compiled default patterns.
 *
 * Compiled on first use rather than at module load: a broken default should
 * fail the call that needed it, not the import of an entire extension.
 */
export function defaultSpeakerTagPatterns(): readonly CompiledSpeakerTagPattern[] {
  return defaultPatterns();
}

/** Lazily compiles one immutable pattern list, memoising the result. */
function compileLazily(
  sources: readonly string[],
): () => readonly CompiledSpeakerTagPattern[] {
  let compiled: readonly CompiledSpeakerTagPattern[] | undefined;
  return () => {
    compiled ??= compileSpeakerTagPatterns(sources);
    return compiled;
  };
}

/**
 * Compiles configured pattern sources, rejecting the ones that cannot work.
 *
 * Every rejection names the offending pattern by position and text: a
 * configuration error that does not say which line is wrong sends the reader
 * looking through the whole file.
 */
export function compileSpeakerTagPatterns(
  sources: readonly string[],
  options: { reportWarning?: (message: string) => void } = {},
): CompiledSpeakerTagPattern[] {
  const compiled: CompiledSpeakerTagPattern[] = [];
  sources.forEach((source, index) => {
    const position = `speaker tag pattern ${index + 1}`;
    if (source.trim() === "") {
      throw new SpeakerTagPatternError(`${position} is empty.`);
    }
    if (source.length > MAX_SPEAKER_TAG_PATTERN_LENGTH) {
      throw new SpeakerTagPatternError(
        `${position} is longer than ${MAX_SPEAKER_TAG_PATTERN_LENGTH} characters: ${source}`,
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SpeakerTagPatternError(
        `${position} is not a valid regular expression (${detail}): ${source}`,
      );
    }

    if (captureGroupCount(regex) === 0) {
      throw new SpeakerTagPatternError(
        `${position} has no capture group for the name: ${source}`,
      );
    }
    // A pattern that matches the empty string would name a speaker for text
    // that has none, and its empty name would overwrite a real attribution.
    if (regex.test("")) {
      options.reportWarning?.(
        `${position} matches the empty string, so it can produce an empty speaker name: ${source}`,
      );
    }

    compiled.push({ source, regex });
  });
  return compiled;
}

/**
 * Counts capturing groups by asking the engine rather than parsing the source.
 *
 * Appending an empty alternative guarantees a match on `""`, and the match
 * array's length is then one more than the number of capturing groups. Parsing
 * parentheses by hand gets escaped and non-capturing forms wrong; this does not.
 */
function captureGroupCount(regex: RegExp): number {
  const probe = new RegExp(`${regex.source}|`);
  const match = probe.exec("");
  return (match?.length ?? 1) - 1;
}

/**
 * Finds the speaker tag in one message, or returns undefined.
 *
 * The first pattern that matches at the position it was anchored to decides:
 * a message carries one tag, and guessing between several would invent
 * attribution rather than read it.
 */
export function findSpeakerTag(
  text: string,
  patterns: readonly CompiledSpeakerTagPattern[] = defaultSpeakerTagPatterns(),
): SpeakerTag | undefined {
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (match === null) {
      continue;
    }
    const name = matchName(match);
    if (name === undefined || name === "") {
      continue;
    }
    const whole = match[0];
    // The anchors may consume whitespace that is not part of the tag; the span
    // covers the tag itself so a caller can remove exactly that.
    const start = match.index + (whole.length - whole.trimStart().length);
    const end =
      match.index + whole.length - (whole.length - whole.trimEnd().length);
    return { name, start, end };
  }
  return undefined;
}

/** Reads the name from a match: a named group wins over the first positional one. */
function matchName(match: RegExpExecArray): string | undefined {
  const named = match.groups?.name;
  const raw = named ?? match[1];
  return raw?.trim();
}

/**
 * Removes the tag a message carries, leaving everything it was attached to.
 *
 * The tag is not part of what was said: it marks who said it. Search text is
 * cleaned with this so a name tag cannot bias matching, while the transcript
 * keeps the tag exactly as written.
 */
export function stripSpeakerTag(
  text: string,
  patterns: readonly CompiledSpeakerTagPattern[] = defaultSpeakerTagPatterns(),
): { text: string; tag?: SpeakerTag } {
  const tag = findSpeakerTag(text, patterns);
  if (tag === undefined) {
    return { text };
  }
  const before = text.slice(0, tag.start);
  const after = text.slice(tag.end);
  return {
    text: `${before}${after}`.trim(),
    tag,
  };
}
