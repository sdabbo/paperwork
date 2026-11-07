/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Each build gets an ID, compiled into the app and published as /version.json, so an open app can tell
// that a newer version was deployed (see src/lib/appUpdate.ts)
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const buildVersion = (): Plugin => ({
  name: 'build-version',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
  },
});

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), buildVersion()],
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      '@': import.meta.dirname,
    },
  },
  test: {
    // The server's tests, and the app's for its plain functions in src/lib
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'src/lib/**/*.test.ts'],
    environment: 'node',
  },
}));
