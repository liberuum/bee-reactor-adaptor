import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000, // 60s per test — live Bee node needs propagation time
    hookTimeout: 30_000, // 30s for beforeAll/afterAll
    // Run test files sequentially — parallel runs against a live Bee node
    // cause feed contention and timeouts (same signer key writing to same feeds)
    fileParallelism: false,
  },
});
