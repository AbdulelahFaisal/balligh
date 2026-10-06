import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.BALLIGH_BASE_URL ?? "http://127.0.0.1:8000",
    channel: process.env.PW_CHANNEL ?? "msedge",
    acceptDownloads: true,
    locale: "ar",
  },
  projects: [
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false } },
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
