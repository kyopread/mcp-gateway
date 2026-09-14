import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/ui',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 1440, height: 1080 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx test/helpers/ui-server.ts',
    url: 'http://127.0.0.1:3100/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
