import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // `server-only` throws outside React Server Components; tests run the server modules directly.
      "server-only": path.resolve(__dirname, "test/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30_000,
  },
});
