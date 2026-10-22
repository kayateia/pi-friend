/**
 * pi-friend-memory
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/** Backend-neutral contract for converting text into dense vectors. */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<Float32Array[]>;
}

/** Configuration for the OpenRouter embeddings API. */
export interface OpenRouterEmbeddingOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  batchSize?: number;
}

/** Error raised when embedding generation fails or returns invalid data. */
export class EmbeddingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1_536;

const MAX_BATCH_SIZE = 128;
const MAX_ERROR_BODY_CHARS = 500;

/**
 * OpenRouter's OpenAI-compatible embeddings implementation.
 *
 * The API key is held only in memory and is never included in thrown errors.
 */
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly batchSize: number;

  constructor(options: OpenRouterEmbeddingOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === "") {
      throw new EmbeddingError("OpenRouter API key must not be empty.");
    }

    const model = (options.model ?? DEFAULT_EMBEDDING_MODEL).trim();
    if (model === "") {
      throw new EmbeddingError("Embedding model must not be empty.");
    }

    const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new EmbeddingError("Embedding dimensions must be a positive integer.");
    }

    const batchSize = options.batchSize ?? 64;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new EmbeddingError(
        `Embedding batch size must be from 1 to ${MAX_BATCH_SIZE}.`,
      );
    }

    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.endpoint = `${(options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/u, "")}/embeddings`;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.batchSize = batchSize;
  }

  /** Embeds all texts while preserving input order across batches. */
  async embed(
    texts: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Float32Array[]> {
    const embeddings: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      options.signal?.throwIfAborted();
      const batch = texts.slice(offset, offset + this.batchSize);
      embeddings.push(...(await this.embedBatch(batch, options.signal)));
    }
    return embeddings;
  }

  /** Embeds one provider batch and validates its response order and shape. */
  private async embedBatch(
    texts: string[],
    signal: AbortSignal | undefined,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.fetchImplementation(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
      signal,
    });

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(
        0,
        MAX_ERROR_BODY_CHARS,
      );
      throw new EmbeddingError(
        `OpenRouter embedding request failed with HTTP ${response.status}${body.trim() ? `: ${body.trim()}` : ""}`,
      );
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new EmbeddingError("OpenRouter embedding response has no data array.");
    }

    const ordered = payload.data
      .map(parseEmbeddingItem)
      .sort((left, right) => left.index - right.index);
    if (ordered.length !== texts.length) {
      throw new EmbeddingError(
        `OpenRouter returned ${ordered.length} embeddings for ${texts.length} inputs.`,
      );
    }

    return ordered.map((item, position) => {
      if (item.index !== position) {
        throw new EmbeddingError("OpenRouter embedding response indices are incomplete.");
      }
      if (item.embedding.length !== this.dimensions) {
        throw new EmbeddingError(
          `Embedding has ${item.embedding.length} dimensions; expected ${this.dimensions}.`,
        );
      }
      for (const value of item.embedding) {
        if (!Number.isFinite(value)) {
          throw new EmbeddingError("Embedding contains a non-finite value.");
        }
      }
      return new Float32Array(item.embedding);
    });
  }
}

/** Resolves an OpenRouter API key from Pi's stored credential or environment. */
export function resolveOpenRouterApiKey(
  env: NodeJS.ProcessEnv = process.env,
  readCredential: typeof readStoredCredential = readStoredCredential,
): string | undefined {
  const credential = readCredential("openrouter");
  if (
    credential?.type === "api_key" &&
    typeof credential.key === "string" &&
    credential.key.trim() !== ""
  ) {
    return credential.key.trim();
  }

  const environmentKey = env.OPENROUTER_API_KEY?.trim();
  return environmentKey === "" ? undefined : environmentKey;
}

/** Parses one embedding item from the provider response. */
function parseEmbeddingItem(value: unknown): {
  index: number;
  embedding: number[];
} {
  if (!isRecord(value)) {
    throw new EmbeddingError("OpenRouter embedding item is not an object.");
  }
  if (!Number.isInteger(value.index) || typeof value.index !== "number") {
    throw new EmbeddingError("OpenRouter embedding item has an invalid index.");
  }
  if (
    !Array.isArray(value.embedding) ||
    !value.embedding.every((item) => typeof item === "number")
  ) {
    throw new EmbeddingError("OpenRouter embedding item has invalid vector data.");
  }

  return {
    index: value.index,
    embedding: value.embedding,
  };
}

/** Narrows unknown JSON values to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
