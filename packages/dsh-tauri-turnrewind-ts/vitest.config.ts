import { defineConfig } from 'vitest/config'

// Tests import from src/ (TS) directly; keep the config local so vitest does
// not climb up and load the desktop shell's vite.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 120000,
  },
})
