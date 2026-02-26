import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    testTimeout: 30000,
    // Integration tests that call FFmpeg get more time
    hookTimeout: 60000,
  },
});
