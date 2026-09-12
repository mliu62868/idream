import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'packages/main/src', testMatch: '**/admin-web.e2e.ts', fullyParallel:false, workers:1, retries:0, reporter:'line', timeout:90000, expect:{timeout:15000}, use:{baseURL:'http://127.0.0.1:3000', actionTimeout:15000, navigationTimeout:30000, trace:'retain-on-failure'} });
