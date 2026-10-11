import { z } from "zod";

import { getEmbeddingEnv } from "@/server/env";

export interface EmbeddingProvider {
  dimensions: number;
  // The optional signal cancels the request (MC-117B: tool-loop
  // cancellation must reach the embedding call); the provider's own
  // timeout still applies either way.
  embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}

type FetchLike = typeof fetch;
export const EMBEDDING_TIMEOUT_MS = 10_000;

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative().optional(),
      embedding: z.array(z.number()),
    }),
  ),
});

export class OpenAiCompatibleEmbeddingProvider
  implements EmbeddingProvider
{
  readonly dimensions: number;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      model: string;
      dimensions: number;
      fetch?: FetchLike;
      timeoutMs?: number;
    },
  ) {
    this.dimensions = options.dimensions;
  }

  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? EMBEDDING_TIMEOUT_MS,
    );
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/embeddings`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: inputs,
            model: this.options.model,
            dimensions: this.options.dimensions,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Embedding request failed with status ${response.status}.`,
        );
      }

      const parsed = embeddingResponseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.data.length !== inputs.length) {
        throw new Error("Embedding provider returned an invalid response.");
      }

      const hasIndexes = parsed.data.data.some(
        (item) => item.index !== undefined,
      );
      if (
        hasIndexes &&
        parsed.data.data.some((item) => item.index === undefined)
      ) {
        throw new Error("Embedding provider returned invalid indexes.");
      }

      const items = hasIndexes
        ? [...parsed.data.data].sort(
            (left, right) => left.index! - right.index!,
          )
        : parsed.data.data;
      if (hasIndexes && items.some((item, index) => item.index !== index)) {
        throw new Error("Embedding provider returned invalid indexes.");
      }
      const embeddings = items.map((item) => item.embedding);
      if (
        embeddings.some(
          (embedding) => embedding.length !== this.options.dimensions,
        )
      ) {
        throw new Error("Embedding provider returned the wrong dimensions.");
      }

      return embeddings;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const env = getEmbeddingEnv();
  if (!env) {
    return null;
  }

  return new OpenAiCompatibleEmbeddingProvider({
    apiKey: env.EMBEDDING_API_KEY,
    baseUrl: env.EMBEDDING_BASE_URL,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
  });
}

export function isMemoryEnabled(): boolean {
  return getEmbeddingProvider() !== null;
}
