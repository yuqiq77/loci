import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleEmbeddingProvider } from "@/server/memory/embedding";

describe("embedding provider", () => {
  it("normalizes OpenAI-compatible responses into input order", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const provider = new OpenAiCompatibleEmbeddingProvider({
      apiKey: "test",
      baseUrl: "https://embedding.example.com/",
      model: "test-model",
      dimensions: 2,
      fetch: fetchMock,
    });

    await expect(provider.embed(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://embedding.example.com/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("aborts the request when the caller's signal fires", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("fetch aborted")),
            { once: true },
          );
        }),
    );
    const provider = new OpenAiCompatibleEmbeddingProvider({
      apiKey: "test",
      baseUrl: "https://embedding.example.com",
      model: "test-model",
      dimensions: 2,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const abort = new AbortController();
    const pending = provider.embed(["query"], abort.signal);
    const failure = pending.catch((error) => error);
    abort.abort();

    await expect(failure).resolves.toBeInstanceOf(Error);
  });

  it("accepts providers that omit indexes and return embeddings in order", async () => {
    const provider = new OpenAiCompatibleEmbeddingProvider({
      apiKey: "test",
      baseUrl: "https://embedding.example.com",
      model: "test-model",
      dimensions: 2,
      fetch: async () =>
        Response.json({
          data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
        }),
    });

    await expect(provider.embed(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("rejects embeddings with the wrong dimensions", async () => {
    const provider = new OpenAiCompatibleEmbeddingProvider({
      apiKey: "test",
      baseUrl: "https://embedding.example.com",
      model: "test-model",
      dimensions: 2,
      fetch: async () =>
        Response.json({ data: [{ index: 0, embedding: [1] }] }),
    });

    await expect(provider.embed(["first"])).rejects.toThrow(
      "wrong dimensions",
    );
  });
});
