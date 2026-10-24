import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    setupFiles: [],
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "./src/shared"),
      "@": path.resolve(import.meta.dirname, "./"),
    },
  },
});
