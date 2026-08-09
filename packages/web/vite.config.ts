import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The workspace package is aliased to its TypeScript source rather than its build
 * output, so the web app never runs against a stale `dist/` while the contracts
 * are being changed.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ffp/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Split the heavy, rarely-changing dependencies into their own chunks.
         *
         * Recharts alone is roughly half the bundle, and only three of the nine
         * pages render a chart. Keeping it separate means the login screen and
         * the budget tables are not waiting on a charting library to download,
         * and a change to application code does not invalidate the vendor cache.
         */
        manualChunks: {
          'vendor-charts': ['recharts'],
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-data': ['@tanstack/react-query', 'zustand', 'zod', 'decimal.js'],
        },
      },
    },
    // The vendor-charts chunk is legitimately large; warn only above it so the
    // threshold still catches genuine application-code bloat.
    chunkSizeWarningLimit: 600,
  },
});
