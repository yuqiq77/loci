import { z } from "zod";

const databaseUrlSchema = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  },
  { message: "DATABASE_URL must use postgres:// or postgresql://" },
);

const databaseEnvSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
});

const sessionSecretSchema = z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength >= 32,
  { message: "SESSION_SECRET must be at least 32 bytes" },
);

const defaultAnthropicBaseUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().default("https://api.anthropic.com"),
);

const sessionEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SESSION_SECRET: sessionSecretSchema,
});

const authEnvSchema = sessionEnvSchema.extend({
  OWNER_PASSWORD_HASH: z.string().min(1),
});

const optionalProviderValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalProviderUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);
const chatEnvSchema = z.object({
  CHAT_API_KEY: z.string().min(1),
  CHAT_BASE_URL: defaultAnthropicBaseUrl,
  CHAT_MODEL: z.string().min(1),
});
const compressionEnvSchema = z.object({
  COMPRESSION_API_KEY: optionalProviderValue,
  COMPRESSION_BASE_URL: optionalProviderUrl,
  COMPRESSION_MODEL: optionalProviderValue,
});
const consolidationEnvSchema = z.object({
  CONSOLIDATION_API_KEY: optionalProviderValue,
  CONSOLIDATION_BASE_URL: optionalProviderUrl,
  CONSOLIDATION_MODEL: optionalProviderValue,
});
const extractionEnvSchema = z.object({
  EXTRACTION_API_KEY: optionalProviderValue,
  EXTRACTION_BASE_URL: optionalProviderUrl,
  EXTRACTION_MODEL: optionalProviderValue,
});
const embeddingEnvSchema = z
  .object({
    EMBEDDING_API_KEY: optionalProviderValue,
    EMBEDDING_BASE_URL: optionalProviderUrl,
    EMBEDDING_MODEL: optionalProviderValue,
    EMBEDDING_DIMENSIONS: z.preprocess(
      (value) => (value === "" || value === undefined ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),
  })
  .superRefine(validateEmbeddingConfiguration);

function validateEmbeddingConfiguration(
  value: {
    EMBEDDING_API_KEY?: string;
    EMBEDDING_BASE_URL?: string;
    EMBEDDING_MODEL?: string;
    EMBEDDING_DIMENSIONS?: number;
  },
  context: z.RefinementCtx,
): void {
  const fields = [
    value.EMBEDDING_API_KEY,
    value.EMBEDDING_BASE_URL,
    value.EMBEDDING_MODEL,
    value.EMBEDDING_DIMENSIONS,
  ];
  const configured = fields.filter((field) => field !== undefined).length;
  if (configured > 0 && configured < fields.length) {
    context.addIssue({
      code: "custom",
      message: "All EMBEDDING_* values are required when memory is enabled",
      path: ["EMBEDDING_API_KEY"],
    });
  }
  if (
    value.EMBEDDING_DIMENSIONS !== undefined &&
    value.EMBEDDING_DIMENSIONS !== 1536
  ) {
    context.addIssue({
      code: "custom",
      message: "EMBEDDING_DIMENSIONS must match vector(1536)",
      path: ["EMBEDDING_DIMENSIONS"],
    });
  }
}

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_ORIGIN: z.url(),
  DATABASE_URL: databaseUrlSchema,
  SESSION_SECRET: sessionSecretSchema,
  OWNER_PASSWORD_HASH: z.string().min(1),
  CHAT_API_KEY: z.string().min(1),
  CHAT_BASE_URL: defaultAnthropicBaseUrl,
  CHAT_MODEL: z.string().min(1),
  COMPRESSION_API_KEY: optionalProviderValue,
  COMPRESSION_BASE_URL: optionalProviderUrl,
  COMPRESSION_MODEL: optionalProviderValue,
  CONSOLIDATION_API_KEY: optionalProviderValue,
  CONSOLIDATION_BASE_URL: optionalProviderUrl,
  CONSOLIDATION_MODEL: optionalProviderValue,
  EXTRACTION_API_KEY: optionalProviderValue,
  EXTRACTION_BASE_URL: optionalProviderUrl,
  EXTRACTION_MODEL: optionalProviderValue,
  EMBEDDING_API_KEY: optionalProviderValue,
  EMBEDDING_BASE_URL: optionalProviderUrl,
  EMBEDDING_MODEL: optionalProviderValue,
  EMBEDDING_DIMENSIONS: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),
}).superRefine(validateEmbeddingConfiguration);

export type SessionEnv = z.infer<typeof sessionEnvSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type ChatEnv = z.infer<typeof chatEnvSchema>;
export type CompressionEnv = {
  COMPRESSION_API_KEY: string;
  COMPRESSION_BASE_URL: string;
  COMPRESSION_MODEL: string;
};
export type ConsolidationEnv = {
  CONSOLIDATION_API_KEY: string;
  CONSOLIDATION_BASE_URL: string;
  CONSOLIDATION_MODEL: string;
};
export type ExtractionEnv = {
  EXTRACTION_API_KEY: string;
  EXTRACTION_BASE_URL: string;
  EXTRACTION_MODEL: string;
};
export type EmbeddingEnv = {
  EMBEDDING_API_KEY: string;
  EMBEDDING_BASE_URL: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: number;
};
export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedSessionEnv: SessionEnv | undefined;
let cachedAuthEnv: AuthEnv | undefined;
let cachedDatabaseEnv: DatabaseEnv | undefined;
let cachedChatEnv: ChatEnv | undefined;
let cachedCompressionEnv: CompressionEnv | undefined;
let cachedConsolidationEnv: ConsolidationEnv | undefined;
let cachedExtractionEnv: ExtractionEnv | undefined;
let cachedEmbeddingEnv: EmbeddingEnv | null | undefined;
let cachedEnv: ServerEnv | undefined;

function parseEnvironment<T>(schema: z.ZodType<T>, label: string): T {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const invalidFields = result.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean)
      .join(", ");

    throw new Error(
      `Invalid ${label} environment configuration: ${
        invalidFields || "unknown error"
      }`,
    );
  }

  return result.data;
}

export function getDatabaseEnv(): DatabaseEnv {
  if (!cachedDatabaseEnv) {
    cachedDatabaseEnv = parseEnvironment(databaseEnvSchema, "database");
  }

  return cachedDatabaseEnv;
}

export function getSessionEnv(): SessionEnv {
  if (!cachedSessionEnv) {
    cachedSessionEnv = parseEnvironment(sessionEnvSchema, "session");
  }

  return cachedSessionEnv;
}

export function getAuthEnv(): AuthEnv {
  if (!cachedAuthEnv) {
    cachedAuthEnv = parseEnvironment(authEnvSchema, "authentication");
  }

  return cachedAuthEnv;
}

export function getChatEnv(): ChatEnv {
  if (!cachedChatEnv) {
    cachedChatEnv = parseEnvironment(chatEnvSchema, "chat provider");
  }

  return cachedChatEnv;
}

export function getCompressionEnv(): CompressionEnv {
  if (!cachedCompressionEnv) {
    const compression = parseEnvironment(
      compressionEnvSchema,
      "compression provider",
    );
    const chat = getChatEnv();
    cachedCompressionEnv = {
      COMPRESSION_API_KEY:
        compression.COMPRESSION_API_KEY ?? chat.CHAT_API_KEY,
      COMPRESSION_BASE_URL:
        compression.COMPRESSION_BASE_URL ?? chat.CHAT_BASE_URL,
      COMPRESSION_MODEL: compression.COMPRESSION_MODEL ?? chat.CHAT_MODEL,
    };
  }

  return cachedCompressionEnv;
}

// The narrative is the highest-leverage text in the system and consolidation
// runs at most ~once a day, so it may use a stronger model than the other
// compression jobs. Falls back to the compression provider when unset.
export function getConsolidationEnv(): ConsolidationEnv {
  if (!cachedConsolidationEnv) {
    const consolidation = parseEnvironment(
      consolidationEnvSchema,
      "consolidation provider",
    );
    const compression = getCompressionEnv();
    cachedConsolidationEnv = {
      CONSOLIDATION_API_KEY:
        consolidation.CONSOLIDATION_API_KEY ?? compression.COMPRESSION_API_KEY,
      CONSOLIDATION_BASE_URL:
        consolidation.CONSOLIDATION_BASE_URL ??
        compression.COMPRESSION_BASE_URL,
      CONSOLIDATION_MODEL:
        consolidation.CONSOLIDATION_MODEL ?? compression.COMPRESSION_MODEL,
    };
  }

  return cachedConsolidationEnv;
}

// Memory extraction reads whole conversation windows and decides what the
// assistant keeps; that is a judgment task, not a mechanical one, so it
// may route to a stronger model than the other compression jobs (MC-119).
// Falls back field-wise to the compression provider when unset, so an
// unconfigured triple changes nothing.
export function getExtractionEnv(): ExtractionEnv {
  if (!cachedExtractionEnv) {
    const extraction = parseEnvironment(
      extractionEnvSchema,
      "extraction provider",
    );
    const compression = getCompressionEnv();
    cachedExtractionEnv = {
      EXTRACTION_API_KEY:
        extraction.EXTRACTION_API_KEY ?? compression.COMPRESSION_API_KEY,
      EXTRACTION_BASE_URL:
        extraction.EXTRACTION_BASE_URL ?? compression.COMPRESSION_BASE_URL,
      EXTRACTION_MODEL:
        extraction.EXTRACTION_MODEL ?? compression.COMPRESSION_MODEL,
    };
  }

  return cachedExtractionEnv;
}

export function getEmbeddingEnv(): EmbeddingEnv | null {
  if (cachedEmbeddingEnv === undefined) {
    const embedding = parseEnvironment(
      embeddingEnvSchema,
      "embedding provider",
    );
    cachedEmbeddingEnv =
      embedding.EMBEDDING_API_KEY &&
      embedding.EMBEDDING_BASE_URL &&
      embedding.EMBEDDING_MODEL &&
      embedding.EMBEDDING_DIMENSIONS
        ? {
            EMBEDDING_API_KEY: embedding.EMBEDDING_API_KEY,
            EMBEDDING_BASE_URL: embedding.EMBEDDING_BASE_URL,
            EMBEDDING_MODEL: embedding.EMBEDDING_MODEL,
            EMBEDDING_DIMENSIONS: embedding.EMBEDDING_DIMENSIONS,
          }
        : null;
  }

  return cachedEmbeddingEnv;
}

export function getServerEnv(): ServerEnv {
  if (!cachedEnv) {
    cachedEnv = parseEnvironment(serverEnvSchema, "server");
  }

  return cachedEnv;
}

export function resetServerEnvForTests(): void {
  cachedSessionEnv = undefined;
  cachedAuthEnv = undefined;
  cachedDatabaseEnv = undefined;
  cachedChatEnv = undefined;
  cachedCompressionEnv = undefined;
  cachedConsolidationEnv = undefined;
  cachedExtractionEnv = undefined;
  cachedEmbeddingEnv = undefined;
  cachedEnv = undefined;
}
