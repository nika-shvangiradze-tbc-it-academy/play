import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'nardi-board.visual.spec.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4200',
    browserName: 'chromium',
  },
  webServer: {
    command: 'npx ng serve --host 127.0.0.1 --port 4200',
    url: 'http://127.0.0.1:4200/dev/nardi-board',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
