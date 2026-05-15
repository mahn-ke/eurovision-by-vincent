const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  timeout: 10_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
  },
  webServer: {
    command: 'node server.js',
    port: 3001,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      TOKENS: 'YWxpY2U6YWJjLGJvYjpkZWYsw7xzZXJuw6TDn2U6Z2hp',
    },
  },
});
