import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Tests import from src/ (TS) directly; keep the config local so vitest does
// not climb up and load the desktop shell's vite.config.ts.
//
// `dsh-tauri/client` must alias to its TS source: the built dist/client.cjs
// begins with `window.__ModuleLoader__.load(...)`, which is a browser-only
// classic script — importing it under Node (the vitest default environment)
// throws `window is not defined` before any test runs.
export default defineConfig({
  resolve: {
    alias: {
      'dsh-tauri/client': resolve(import.meta.dirname, '../dsh-tauri/src/client/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 120000,
  },
})
