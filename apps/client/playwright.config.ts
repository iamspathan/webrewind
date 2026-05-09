import { defineConfig, devices } from "@playwright/test";

// Smoke-level E2E. Tests boot the client via Vite's preview server so we
// exercise the production bundle (not the dev-mode HMR runtime). We do not
// launch the API server — the test suite mocks /screenshots and its SSE
// stream with page.route().

const PORT = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Build + preview the client before running tests. We use `vite preview`
  // rather than `vite dev` because the dev server's module graph is slow
  // to warm and occasionally hangs the first page load in CI.
  webServer: {
    command: `yarn build && yarn preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
