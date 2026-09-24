import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

// Two tiers, so the build job never needs a database and the database tier
// cannot be skipped by accident:
//
// - `unit` (`npm run test`): mocks only, no services, runs anywhere.
// - `db` (`npm run test:db`): every `*.db.test.ts`, against the local Supabase
//   from `supabase start`. lib/__tests__/support/db-setup.ts loads the env the
//   way `next dev` does and refuses, before any test body runs, when a database
//   URL is not on this machine. CI runs it in the e2e job, which owns a stack.
//
// Playwright owns e2e/; its specs share the .spec.ts suffix vitest looks for.
const exclude = [...configDefaults.exclude, "e2e/**"];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...exclude, "**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["**/*.db.test.ts"],
          exclude,
          setupFiles: ["./lib/__tests__/support/db-setup.ts"],
          // One file at a time: the suites sign users in and cascade-delete
          // accounts on one local GoTrue and Postgres, which on a laptop is
          // usually shared with a dev server, and they are quick enough serial.
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
