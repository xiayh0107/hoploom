import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'jsdom', setupFiles: ['src/test-setup.ts'],
  include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true,
  // Keep isolated DOM workers within the shared CI runners' CPU capacity.
  maxWorkers: process.env.CI ? 2 : undefined,
} });
