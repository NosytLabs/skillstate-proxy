import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live tests hit tokenrouter free tier (slow cold starts up to ~60s/step).
    testTimeout: 300000,
    hookTimeout: 30000,
    include: ["test/**/*.test.ts"],
  },
});
