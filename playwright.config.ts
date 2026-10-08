import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./apps/web/tests",
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3300",
    viewport: { width: 1440, height: 1000 },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    reducedMotion: "reduce",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
