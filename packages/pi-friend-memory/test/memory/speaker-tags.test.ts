/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConfigError, parseMemoryConfig } from "../../src/memory/config.ts";
import {
  SpeakerTagPatternError,
  compileSpeakerTagPatterns,
  defaultSpeakerTagPatterns,
  findSpeakerTag,
  stripSpeakerTag,
} from "../../src/memory/speaker-tags.ts";

test("every default prefix form yields the name and the tag's own span", () => {
  const cases = [
    { text: "\\>>Aria: the sweep ran", name: "Aria", tag: "\\>>Aria:" },
    { text: "<Aria> the sweep ran", name: "Aria", tag: "<Aria>" },
    { text: "Aria> the sweep ran", name: "Aria", tag: "Aria>" },
    { text: "[Aria] the sweep ran", name: "Aria", tag: "[Aria]" },
  ];
  for (const example of cases) {
    const tag = findSpeakerTag(example.text);
    assert.ok(tag, `expected a tag in ${JSON.stringify(example.text)}`);
    assert.equal(tag.name, example.name);
    assert.equal(example.text.slice(tag.start, tag.end), example.tag);
  }

  // Leading whitespace is not part of the tag, so removing it leaves the
  // message's own spacing alone.
  const indented = findSpeakerTag("  \\>>Aria: hello");
  assert.ok(indented);
  assert.equal(indented.start, 2);
});

test("default suffix forms close a message", () => {
  for (const text of ["see you then -Aria", "see you then ~Aria"]) {
    const tag = findSpeakerTag(text);
    assert.ok(tag, `expected a tag in ${JSON.stringify(text)}`);
    assert.equal(tag.name, "Aria");
    assert.equal(text.slice(tag.start, tag.end), text.slice(text.lastIndexOf(" ") + 1));
  }

  // A hyphenated word with no sigil is part of the sentence either way.
  assert.equal(findSpeakerTag("well-known"), undefined);
});

test("a name is one word: lowercase, apostrophised and hyphenated are all allowed", () => {
  assert.equal(findSpeakerTag("\\>>aria: hi")?.name, "aria");
  assert.equal(findSpeakerTag("[O'Brien] hi")?.name, "O'Brien");
  assert.equal(findSpeakerTag("[Anne-Marie] hi")?.name, "Anne-Marie");
  // Case is not evidence of a name: lowercase compounds are real names, and a
  // capitalisation rule would turn them away.
  assert.equal(
    findSpeakerTag("[st-jean-sur-richelieu] hi")?.name,
    "st-jean-sur-richelieu",
  );

  // A space ends the name, so a full name is not a default tag. A house that
  // signs with one configures its own patterns instead.
  assert.equal(findSpeakerTag("[Aria Nightshade] hi"), undefined);
  assert.equal(findSpeakerTag("\\>>Aria Nightshade: hi"), undefined);
  assert.equal(findSpeakerTag("see you then -Aria Nightshade"), undefined);
});

test("prose ending in a hyphenated phrase is not a signature", () => {
  // One-word names are what make this safe: the word before the end is not the
  // end of the text, so the suffix form has nothing to match.
  assert.equal(findSpeakerTag("the -Aria-prefixed form"), undefined);
  assert.equal(findSpeakerTag("a well-known format"), undefined);

  // A single trailing word still signs the message — it just has to be last.
  assert.equal(findSpeakerTag("the -Aria-prefixed")?.name, "Aria-prefixed");
});

test("ordinary prose is not a tag", () => {
  for (const text of [
    "Note: the sweep runs at midnight.",
    "TODO: buy milk",
    "Aria said the sweep runs at midnight.",
    "[docs](https://example.com) is the link",
    "<https://example.com> is a URL",
    "She said hi > goodbye",
  ]) {
    assert.equal(
      findSpeakerTag(text),
      undefined,
      `expected no tag in ${JSON.stringify(text)}`,
    );
  }
});

test("a bracketed timestamp is not a name, but it hides a tag behind it", () => {
  // pi-time-awareness prefixes person-authored messages before the model sees
  // them: "[Mon 2026-11-02 16:31 EST] ". It is at the start, in brackets, and
  // must not read as attribution — the digits and colons inside see to that.
  const stamped = "[Mon 2026-11-02 16:31 EST] hello";
  assert.equal(findSpeakerTag(stamped), undefined);

  // The timestamp does, however, push a real tag off the start of the text, so
  // a caller given stamped content has to remove the timestamp first. That is
  // recorded here because the two extensions meet exactly at this point.
  const both = "[Mon 2026-11-02 16:31 EST] \\>>Aria: hello";
  assert.equal(findSpeakerTag(both), undefined);
  const unstamped = both.replace(/^\[[^\]]+\] /u, "");
  assert.equal(findSpeakerTag(unstamped)?.name, "Aria");
});

test("stripping removes only the tag", () => {
  assert.deepEqual(stripSpeakerTag("\\>>Aria: hello there").text, "hello there");
  assert.deepEqual(stripSpeakerTag("hello there -Aria").text, "hello there");
  assert.deepEqual(stripSpeakerTag("no tag here").text, "no tag here");
  assert.equal(stripSpeakerTag("no tag here").tag, undefined);
});

test("configured patterns replace the defaults", () => {
  const patterns = compileSpeakerTagPatterns([
    String.raw`^(?<name>[A-Z][a-z]+) says:`,
  ]);
  const tag = findSpeakerTag("Aisling says: the sweep ran", patterns);
  assert.equal(tag?.name, "Aisling");
  // The default forms are gone with them.
  assert.equal(findSpeakerTag("\\>>Aria: the sweep ran", patterns), undefined);
});

test("a pattern that cannot be used is rejected by position and text", () => {
  const cases: Array<{ pattern: string; message: RegExp }> = [
    { pattern: "", message: /pattern 1 is empty/u },
    { pattern: "(", message: /pattern 1 is not a valid regular expression/u },
    {
      pattern: String.raw`^Aria:`,
      message: /pattern 1 has no capture group for the name/u,
    },
    {
      pattern: `^(${"a".repeat(300)})`,
      message: /pattern 1 is longer than 200 characters/u,
    },
  ];
  for (const example of cases) {
    assert.throws(
      () => compileSpeakerTagPatterns([example.pattern]),
      (error: unknown) =>
        error instanceof SpeakerTagPatternError && example.message.test(error.message),
    );
  }
});

test("a pattern that matches the empty string warns rather than failing", () => {
  const warnings: string[] = [];
  const compiled = compileSpeakerTagPatterns([String.raw`^(Aria)?`], {
    reportWarning: (message) => warnings.push(message),
  });
  assert.equal(compiled.length, 1);
  assert.match(warnings[0] ?? "", /matches the empty string/u);
});

test("the compiled defaults are reused across calls", () => {
  assert.equal(defaultSpeakerTagPatterns(), defaultSpeakerTagPatterns());
  assert.ok(defaultSpeakerTagPatterns().length >= 5);
});

test("memory.speaker_tags.patterns configures the recogniser", () => {
  const config = parseMemoryConfig(
    [
      "memory:",
      "  speaker_tags:",
      "    patterns:",
      String.raw`      - '^--- (\w+)$'`,
    ].join("\n"),
    "/tmp/pi-friend/pi-friend-memory.yml",
    "/tmp",
  );
  assert.deepEqual(config.speakerTags.patterns, [String.raw`^--- (\w+)$`]);
});

test("an unusable speaker-tag pattern is a configuration error", () => {
  const cases = [
    {
      body: ["  speaker_tags:", "    patterns: []"].join("\n"),
      message: /must be a non-empty list of regular expressions/u,
    },
    {
      body: ["  speaker_tags:", "    patterns: ['   ']"].join("\n"),
      message: /patterns\[0\] must be a non-empty string/u,
    },
    {
      body: ["  speaker_tags:", "    patterns: [42]"].join("\n"),
      message: /patterns\[0\] must be a non-empty string/u,
    },
    {
      body: ["  speaker_tags:", "    patterns: ['(']"].join("\n"),
      message: /not a valid regular expression/u,
    },
    {
      body: ["  speaker_tags:", "    patterns: ['^Aria:']"].join("\n"),
      message: /no capture group for the name/u,
    },
  ];
  for (const example of cases) {
    assert.throws(
      () =>
        parseMemoryConfig(
          `memory:\n${example.body}`,
          "/tmp/pi-friend/pi-friend-memory.yml",
          "/tmp",
        ),
      (error: unknown) =>
        error instanceof MemoryConfigError && example.message.test(error.message),
    );
  }
});

test("an empty list is an error, not a way to switch recognition off", () => {
  // A silent "no patterns" would turn tag recognition off while leaving the
  // config looking deliberate, and the bias this feature exists to remove — a
  // name in a query pulling results toward it — would come back unnoticed. If a
  // house ever genuinely wants recognition off, that wants its own key rather
  // than an overloaded empty list.
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  speaker_tags:\n    patterns: []",
        "/tmp/pi-friend/pi-friend-memory.yml",
        "/tmp",
      ),
    /non-empty list/u,
  );
});

test("a whitespace-only entry is rejected before the regex compiler sees it", () => {
  assert.throws(
    () =>
      parseMemoryConfig(
        "memory:\n  speaker_tags:\n    patterns: ['   ']",
        "/tmp/pi-friend/pi-friend-memory.yml",
        "/tmp",
      ),
    /patterns\[0\] must be a non-empty string/u,
  );
});

test("an unknown field under speaker_tags is reported, not fatal", () => {
  const config = parseMemoryConfig(
    ["memory:", "  speaker_tags:", "    pattern: ['^Aria:']"].join("\n"),
    "/tmp/pi-friend/pi-friend-memory.yml",
    "/tmp",
  );
  assert.match(config.warnings.join("\n"), /memory\.speaker_tags: unknown field "pattern"/u);
  // The typo does not leave the recogniser silently unconfigured: the defaults
  // still apply.
  assert.deepEqual(config.speakerTags.patterns, [
    ...defaultSpeakerTagPatterns().map((pattern) => pattern.source),
  ]);
});
