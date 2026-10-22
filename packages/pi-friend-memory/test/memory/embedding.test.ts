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
  EmbeddingError,
  OpenRouterEmbeddingProvider,
  resolveOpenRouterApiKey,
} from "../../src/memory/embedding.ts";

test("stored OpenRouter API keys take precedence over environment values", () => {
  assert.equal(
    resolveOpenRouterApiKey(
      { OPENROUTER_API_KEY: "env-key" },
      () => ({ type: "api_key", key: "stored-key" }),
    ),
    "stored-key",
  );
  assert.equal(
    resolveOpenRouterApiKey(
      { OPENROUTER_API_KEY: "env-key" },
      () => ({ type: "api_key", key: "  " }),
    ),
    "env-key",
  );
  assert.equal(
    resolveOpenRouterApiKey(
      {},
      () => undefined,
    ),
    undefined,
  );
});

test("OpenRouter embedding batches preserve order and validate dimensions", async () => {
  const requestBodies: unknown[] = [];
  const fetchImplementation: typeof fetch = async (_input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    requestBodies.push(body);
    const input = isRecord(body) && Array.isArray(body.input)
      ? body.input
      : [];
    const data = input.map((_text, index) => ({
      index,
      embedding: index === 0
        ? [1, 0, 0]
        : [0, 1, 0],
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const provider = new OpenRouterEmbeddingProvider({
    apiKey: "test-key",
    dimensions: 3,
    batchSize: 2,
    fetchImplementation,
  });
  const embeddings = await provider.embed(["one", "two", "three"]);

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(Array.from(embeddings[0] ?? []), [1, 0, 0]);
  assert.deepEqual(Array.from(embeddings[1] ?? []), [0, 1, 0]);
  assert.deepEqual(Array.from(embeddings[2] ?? []), [1, 0, 0]);
});

test("OpenRouter embedding errors do not include the API key", async () => {
  const provider = new OpenRouterEmbeddingProvider({
    apiKey: "secret-key",
    dimensions: 3,
    fetchImplementation: async () =>
      new Response("provider rejected request", {
        status: 401,
        headers: { "content-type": "text/plain" },
      }),
  });

  await assert.rejects(
    () => provider.embed(["hello"]),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.message.includes("secret-key"), false);
      return true;
    },
  );
});

test("OpenRouter embedding dimension mismatches are rejected", async () => {
  const provider = new OpenRouterEmbeddingProvider({
    apiKey: "test-key",
    dimensions: 3,
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 0] }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  });

  await assert.rejects(
    () => provider.embed(["hello"]),
    /expected 3/,
  );
});

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
