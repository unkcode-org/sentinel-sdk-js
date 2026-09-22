import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts", "test/contract/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
