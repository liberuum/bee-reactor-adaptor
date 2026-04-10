import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000, // 60s per test — live Bee node needs propagation time
    hookTimeout: 30_000, // 30s for beforeAll/afterAll
  },
});
