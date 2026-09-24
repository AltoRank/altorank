import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

// Two tiers, so the build job never needs a database and the database tier
// cannot be skipped by accident:
//
// - `unit` (`npm run test`): mocks only, no services, runs anywhere.
//   lib/__tests__/support/unit-setup.ts refuses a production database URL in
//   the shell, removes the rest so every machine sees what CI sees, and
//   installs the network guard, which lets no connection out of the process
//   except to a server the test itself started.
// - `db` (`npm run test:db`): every `*.db.test.ts`, against the local Supabase
//   from `supabase start`. lib/__tests__/support/db-setup.ts installs the
//   network guard in loopback mode (nothing that is not on this machine), then
//   takes the local stack's URL and keys from the files `next dev` reads (and
//   nothing else from them) and refuses, before any test body runs, when a
//   database URL is not on this machine. CI runs it in the e2e job, which
//   owns a stack.
//
// Which tier a file lands in is decided by its name, so the pattern covers
// every extension vitest collects (a `.db.test.tsx` or `.db.spec.mts` is a db
// test too), and lib/__tests__/test-tiers.test.ts fails when a file that is not
// named as a db test reaches for the local stack or an env file.
//
// Playwright owns e2e/; its specs share the .spec.ts suffix vitest looks for.
const DB_TESTS = "**/*.db.{test,spec}.?(c|m)[jt]s?(x)";
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
          exclude: [...exclude, DB_TESTS],
          setupFiles: ["./lib/__tests__/support/unit-setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: [DB_TESTS],
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
