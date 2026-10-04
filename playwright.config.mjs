import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  projects: [
    {
      name: "desktop",
      use: { deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } },
    },
    {
      name: "retina",
      use: { deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } },
    },
  ],
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "node scripts/serve.mjs",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
