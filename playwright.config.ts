import { defineConfig, devices } from "@playwright/test";

const externalURL = process.env.FIELDLEDGER_TEST_URL;
const baseURL = externalURL || "http://127.0.0.1:3018";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: externalURL ? undefined : {
    command: "npm start",
    env: { PORT: "3018", APP_ORIGIN: baseURL, NODE_ENV: "test" },
    url: baseURL + "/api/health",
    reuseExistingServer: false,
  },
});
