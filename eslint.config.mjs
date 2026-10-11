import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    ".next-verify/**",
    "coverage/**",
    "drizzle/meta/**",
    "next-env.d.ts",
    "playwright-report/**",
    ".claude/**",
    "release/overlay/**",
    "test-results/**",
  ]),
]);
