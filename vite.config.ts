import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-redux': ['@reduxjs/toolkit', 'react-redux'],
          'vendor-ui':   ['@headlessui/react', '@heroicons/react'],
        },
      },
    },
  },
  resolve: {
    // Ensure a single copy of these packages resolves from the project root,
    // preventing the global ~/node_modules copy from being picked up in tests.
    dedupe: ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Only pick up frontend unit tests — backend and E2E have their own runners.
    include: ['src/__tests__/**/*.test.{ts,tsx,js,jsx}'],
    server: {
      deps: {
        // Force these through Vite's bundler so they resolve from project root.
        inline: ['react-redux', '@reduxjs/toolkit'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: ['src/main.tsx', 'src/test/**'],
    },
  },
})
