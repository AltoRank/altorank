import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare build output (opt-in, see docs/deploy-cloudflare.md). 46 MB of
    // generated bundles; linting them runs Node out of heap.
    ".open-next/**",
    ".wrangler/**",
  ]),
  {
    rules: {
      // A leading underscore is how this codebase says "unused on purpose": a
      // mock that has to match a signature it ignores (`vi.fn((_args) => ...)`).
      // Without this, those are warnings nobody acts on, and `lint:guarded`
      // could not run with --max-warnings 0, so a new, real unused variable in
      // a guarded path would pass CI as just one more warning.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
]);

export default eslintConfig;
