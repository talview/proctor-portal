/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // pdfjs-dist is only reachable via NdaSignPage's lazy import, so it's
          // already its own chunk by Rollup's dynamic-import boundary -- naming it
          // explicitly just makes that boundary clear and keeps it out of the
          // shared vendor chunk below, which every route loads.
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('react-router')) {
            return 'vendor-react';
          }
          if (
            id.includes('@tanstack/react-query') ||
            id.includes('@supabase/supabase-js') ||
            id.includes('zustand') ||
            id.includes('date-fns')
          ) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
    // pdfjs-dist (see vendor-pdf above) and exceljs are both genuinely large
    // libraries that are already isolated behind their own dynamic import (NDA
    // signing's lazy route, and the group-evaluation xlsx helpers' `await
    // import('exceljs')` inside assessmentGroupXlsx.ts) -- confirmed via
    // dist/index.html referencing neither chunk, so neither is fetched on initial
    // page load, only when that specific feature actually runs. Raising this past
    // exceljs's ~940KB just avoids a warning for chunks that are expected to stay
    // large and are already lazy, rather than chasing further splits for no real
    // load-time benefit.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'src/test/'],
    },
  },
})
