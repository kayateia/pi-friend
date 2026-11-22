/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryTools } from "../../src/tools/memory-tools.ts";
import type { MemoryNodeService } from "../../src/memory/service.ts";

/** The shape the edit tool's execute returns, reduced to what these tests read. */
interface EditResult {
  content: { text: string }[];
  details: { edited: string };
}

/**
 * Registers the tools against a service whose `edit` returns one node.
 *
 * Only the message is under test: `edited` is absent on a node that has never
 * had a substantive edit, and the result text has to say something true in both
 * cases.
 */
async function callEdit(edited: string | undefined): Promise<EditResult> {
  const definitions = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string }) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;

  const service = {
    async edit() {
      return {
        slug: "kettle",
        body: "\nThe kettle is blue.\n",
        frontMatter: {
          type: "fact",
          status: "active",
          ...(edited === undefined ? {} : { edited }),
        },
      };
    },
  };
  registerMemoryTools(pi, () => service as unknown as MemoryNodeService);

  const definition = definitions.get("memory_edit") as {
    execute: (id: string, params: unknown) => Promise<EditResult>;
  };
  return definition.execute("call", { slug: "kettle", tags: ["kitchen"] });
}

test("an edit that moved nothing says the date is unset", async () => {
  const result = await callEdit(undefined);

  assert.match(result.content[0]?.text ?? "", /Updated memory "kettle"/u);
  assert.match(result.content[0]?.text ?? "", /No substantive change/u);
  // The old wording interpolated the date unconditionally, which printed
  // "Updated memory "x" at ." on every metadata-only edit.
  assert.doesNotMatch(result.content[0]?.text ?? "", / at \./u);
  assert.equal(result.details.edited, "");
});

test("an edit reports the content date when the node has one", async () => {
  const result = await callEdit("2026-11-22T01:25:31.754Z");

  assert.match(
    result.content[0]?.text ?? "",
    /Content last changed: 2026-11-22T01:25:31\.754Z\./u,
  );
  assert.equal(result.details.edited, "2026-11-22T01:25:31.754Z");
});
