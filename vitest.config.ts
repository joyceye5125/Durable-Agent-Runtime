import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests share one Postgres database when TEST_DATABASE_URL is set.
    fileParallelism: false,
  },
});
