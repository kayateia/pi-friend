/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryDateFilterError,
  resolveDateBound,
  resolveDateWindow,
} from "../../src/memory/date-filter.ts";

test("a bare date covers a whole local calendar day", () => {
  // Compared against the same local-time construction rather than a fixed UTC
  // string, so the assertion describes the rule and not the machine's zone.
  assert.equal(
    resolveDateBound("2026-11-08", "since"),
    new Date(2026, 10, 8, 0, 0, 0, 0).toISOString(),
  );
  assert.equal(
    resolveDateBound("2026-11-08", "until"),
    new Date(2026, 10, 8, 23, 59, 59, 999).toISOString(),
  );
  // The two bounds of one day meet exactly: nothing falls between them.
  const since = resolveDateBound("2026-11-08", "since");
  const until = resolveDateBound("2026-11-08", "until");
  assert.equal(since <= until, true);
});

test("a timestamp is taken as that exact instant", () => {
  assert.equal(
    resolveDateBound("2026-11-08T09:30:00Z", "since"),
    "2026-11-08T09:30:00.000Z",
  );
  assert.equal(
    resolveDateBound("2026-11-08T04:30:00-05:00", "until"),
    "2026-11-08T09:30:00.000Z",
  );
});

test("an impossible or unreadable date is an error, not an empty answer", () => {
  assert.throws(
    () => resolveDateBound("2026-02-31", "since"),
    (error: unknown) =>
      error instanceof MemoryDateFilterError && /not a real calendar date/u.test(error.message),
  );
  assert.throws(
    () => resolveDateBound("last tuesday", "since"),
    (error: unknown) =>
      error instanceof MemoryDateFilterError && /Could not read since/u.test(error.message),
  );
});

test("an inverted window is rejected and named", () => {
  assert.deepEqual(resolveDateWindow("2026-11-01", undefined), {
    since: resolveDateBound("2026-11-01", "since"),
  });
  assert.throws(
    () => resolveDateWindow("2026-11-08", "2026-11-01"),
    (error: unknown) =>
      error instanceof MemoryDateFilterError &&
      /later than until/u.test(error.message),
  );
});
