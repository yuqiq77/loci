import { afterEach, describe, expect, it } from "vitest";

import {
  getChatEnv,
  getCompressionEnv,
  getConsolidationEnv,
  getDatabaseEnv,
  getExtractionEnv,
  getEmbeddingEnv,
  getSessionEnv,
  getServerEnv,
  resetServerEnvForTests,
} from "@/server/env";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetServerEnvForTests();
});

describe("getServerEnv", () => {
  it("returns validated server configuration", () => {
    process.env.APP_ORIGIN = "http://localhost:3000";
    process.env.DATABASE_URL =
      "postgresql://loci:loci@localhost:5432/loci";
    process.env.SESSION_SECRET = "s".repeat(32);
    process.env.OWNER_PASSWORD_HASH = "test-hash";
    process.env.CHAT_API_KEY = "test-api-key";
    process.env.CHAT_MODEL = "claude-test";
    process.env.CHAT_BASE_URL = "";

    expect(getServerEnv()).toMatchObject({
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: "postgresql://loci:loci@localhost:5432/loci",
      SESSION_SECRET: "s".repeat(32),
      OWNER_PASSWORD_HASH: "test-hash",
      CHAT_API_KEY: "test-api-key",
      CHAT_BASE_URL: "https://api.anthropic.com",
      CHAT_MODEL: "claude-test",
    });
  });

  it("reports missing required variables without exposing values", () => {
    delete process.env.APP_ORIGIN;
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.OWNER_PASSWORD_HASH;
    delete process.env.CHAT_API_KEY;
    process.env.CHAT_BASE_URL = "";
    delete process.env.CHAT_MODEL;

    expect(() => getServerEnv()).toThrow(
      "Invalid server environment configuration: APP_ORIGIN, DATABASE_URL, SESSION_SECRET, OWNER_PASSWORD_HASH, CHAT_API_KEY, CHAT_MODEL",
    );
  });

  it("uses the native Anthropic base URL by default", () => {
    process.env.CHAT_API_KEY = "test-api-key";
    process.env.CHAT_MODEL = "claude-test";
    delete process.env.CHAT_BASE_URL;

    expect(getChatEnv()).toEqual({
      CHAT_API_KEY: "test-api-key",
      CHAT_BASE_URL: "https://api.anthropic.com",
      CHAT_MODEL: "claude-test",
    });
  });

  it("falls back to chat configuration for compression", () => {
    process.env.CHAT_API_KEY = "chat-key";
    process.env.CHAT_BASE_URL = "https://chat.example.com";
    process.env.CHAT_MODEL = "chat-model";
    process.env.COMPRESSION_API_KEY = "";
    process.env.COMPRESSION_BASE_URL = "";
    process.env.COMPRESSION_MODEL = "";

    expect(getCompressionEnv()).toEqual({
      COMPRESSION_API_KEY: "chat-key",
      COMPRESSION_BASE_URL: "https://chat.example.com",
      COMPRESSION_MODEL: "chat-model",
    });
  });

  it("allows a separate compression provider configuration", () => {
    process.env.CHAT_API_KEY = "chat-key";
    process.env.CHAT_MODEL = "chat-model";
    process.env.COMPRESSION_API_KEY = "compression-key";
    process.env.COMPRESSION_BASE_URL = "https://compression.example.com";
    process.env.COMPRESSION_MODEL = "compression-model";

    expect(getCompressionEnv()).toEqual({
      COMPRESSION_API_KEY: "compression-key",
      COMPRESSION_BASE_URL: "https://compression.example.com",
      COMPRESSION_MODEL: "compression-model",
    });
  });

  it("falls back to the compression provider for consolidation", () => {
    process.env.CHAT_API_KEY = "chat-key";
    process.env.CHAT_MODEL = "chat-model";
    process.env.COMPRESSION_API_KEY = "compression-key";
    process.env.COMPRESSION_BASE_URL = "https://compression.example.com";
    process.env.COMPRESSION_MODEL = "compression-model";
    process.env.CONSOLIDATION_API_KEY = "";
    process.env.CONSOLIDATION_BASE_URL = "";
    process.env.CONSOLIDATION_MODEL = "";

    expect(getConsolidationEnv()).toEqual({
      CONSOLIDATION_API_KEY: "compression-key",
      CONSOLIDATION_BASE_URL: "https://compression.example.com",
      CONSOLIDATION_MODEL: "compression-model",
    });
  });

  it("allows a separate consolidation provider configuration", () => {
    process.env.CHAT_API_KEY = "chat-key";
    process.env.CHAT_MODEL = "chat-model";
    process.env.COMPRESSION_API_KEY = "compression-key";
    process.env.COMPRESSION_BASE_URL = "https://compression.example.com";
    process.env.COMPRESSION_MODEL = "compression-model";
    process.env.CONSOLIDATION_API_KEY = "consolidation-key";
    process.env.CONSOLIDATION_BASE_URL = "https://consolidation.example.com";
    process.env.CONSOLIDATION_MODEL = "consolidation-model";

    expect(getConsolidationEnv()).toEqual({
      CONSOLIDATION_API_KEY: "consolidation-key",
      CONSOLIDATION_BASE_URL: "https://consolidation.example.com",
      CONSOLIDATION_MODEL: "consolidation-model",
    });
  });

  it("falls back to the compression provider for extraction", () => {
    process.env.CHAT_API_KEY = "chat-key";
    process.env.CHAT_MODEL = "chat-model";
    process.env.COMPRESSION_API_KEY = "compression-key";
    process.env.COMPRESSION_BASE_URL = "https://compression.example.com";
    process.env.COMPRESSION_MODEL = "compression-model";
    process.env.EXTRACTION_API_KEY = "";
    process.env.EXTRACTION_BASE_URL = "";
    process.env.EXTRACTION_MODEL = "";

    expect(getExtractionEnv()).toEqual({
      EXTRACTION_API_KEY: "compression-key",
      EXTRACTION_BASE_URL: "https://compression.example.com",
      EXTRACTION_MODEL: "compression-model",
    });
  });

  it("allows a separate extraction provider configuration", () => {
    process.env.CHAT_API_KEY = "chat-key";
    process.env.CHAT_MODEL = "chat-model";
    process.env.COMPRESSION_API_KEY = "compression-key";
    process.env.COMPRESSION_BASE_URL = "https://compression.example.com";
    process.env.COMPRESSION_MODEL = "compression-model";
    process.env.EXTRACTION_API_KEY = "extraction-key";
    process.env.EXTRACTION_BASE_URL = "https://extraction.example.com";
    process.env.EXTRACTION_MODEL = "extraction-model";

    expect(getExtractionEnv()).toEqual({
      EXTRACTION_API_KEY: "extraction-key",
      EXTRACTION_BASE_URL: "https://extraction.example.com",
      EXTRACTION_MODEL: "extraction-model",
    });
  });

  it("disables memory when embedding configuration is absent", () => {
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMENSIONS;

    expect(getEmbeddingEnv()).toBeNull();
  });

  it("validates the fixed vector dimensions", () => {
    process.env.EMBEDDING_API_KEY = "embedding-key";
    process.env.EMBEDDING_BASE_URL = "https://embedding.example.com";
    process.env.EMBEDDING_MODEL = "embedding-model";
    process.env.EMBEDDING_DIMENSIONS = "768";

    expect(() => getEmbeddingEnv()).toThrow(
      "Invalid embedding provider environment configuration: EMBEDDING_DIMENSIONS",
    );
  });

  it("validates database configuration without requiring APP_ORIGIN", () => {
    delete process.env.APP_ORIGIN;
    process.env.DATABASE_URL =
      "postgresql://loci:loci@localhost:5432/loci";

    expect(getDatabaseEnv()).toEqual({
      DATABASE_URL: "postgresql://loci:loci@localhost:5432/loci",
    });
  });

  it("rejects non-PostgreSQL database URLs", () => {
    process.env.DATABASE_URL = "https://example.com/database";

    expect(() => getDatabaseEnv()).toThrow(
      "Invalid database environment configuration: DATABASE_URL",
    );
  });

  it("rejects session secrets shorter than 32 bytes", () => {
    Object.assign(process.env, { NODE_ENV: "test" });
    process.env.SESSION_SECRET = "too-short";

    expect(() => getSessionEnv()).toThrow(
      "Invalid session environment configuration: SESSION_SECRET",
    );
  });
});
