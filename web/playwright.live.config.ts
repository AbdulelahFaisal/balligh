import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e-live",
  timeout: 15 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results-live",
  use: {
    baseURL: process.env.BALLIGH_BASE_URL ?? "http://127.0.0.1:8000",
    channel: process.env.PW_CHANNEL ?? "msedge",
    locale: "ar",
    viewport: { width: 1440, height: 900 },
  },
});
