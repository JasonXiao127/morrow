import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// The scheduling tests assert wall-clock behaviour around DST. Pin the
// process timezone before Vitest starts its workers so results do not depend
// on the machine running the suite.
process.env["TZ"] = "America/New_York";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
  },
});
