import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: !process.env.TEST_DATABASE_URL,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
