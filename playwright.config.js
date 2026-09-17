import { defineConfig, devices } from "@playwright/test";

// Dedicated ports keep browser tests separate from npm run dev and API tests.
const ports = {
  gateway: 4300,
  user: 4301,
  catalog: 4302,
  playback: 4303,
  watchHistory: 4304,
  subscription: 4305,
  billing: 4306,
  notification: 4307,
  recommendation: 4308,
};
const envNames = { watchHistory: "WATCH_HISTORY" };
const serviceEnv = {};
for (const [service, port] of Object.entries(ports)) {
  const name = envNames[service] || service.toUpperCase();
  serviceEnv[`PORT_${name}`] = String(port);
  serviceEnv[service === "gateway" ? "GATEWAY_URL" : `${name}_SERVICE_URL`] =
    `http://127.0.0.1:${port}`;
}

export default defineConfig({
  testDir: "./test/browser",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4300",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/dev-all.js",
    url: "http://127.0.0.1:4300/ops/services",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      ...serviceEnv,
      DATA_DRIVER: "memory",
      CACHE_DRIVER: "memory",
      BUS_DRIVER: "memory",
      LOG_LEVEL: "silent",
    },
  },
});
