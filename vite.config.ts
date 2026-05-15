import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite's UserConfig doesn't know about Vitest's `test` block. Augmenting with
// vitest's module-augmentation has been flaky across versions, so we type the
// config locally and cast.
type ViteUserConfigWithTest = UserConfig & { test?: Record<string, unknown> };

export default defineConfig({
  plugins: [react()],
  // Sentry exposes `__SENTRY_TRACING__` and `__SENTRY_DEBUG__` as build-time
  // flags. When defined to `false`, Sentry's own tree-shaking drops the
  // tracing-only code paths (helper functions, span machinery, transport
  // overhead) — typically 25-30 KB gzip off the deferred Sentry chunk.
  // We default to tracing OFF and let env opt back in. Debug is always off
  // in production builds.
  // Build-time feature flags. Defining these as literal booleans (not env
  // string comparisons inside the source) lets esbuild's dead-code path
  // strip the whole branch + all symbols it references. Sentry's tracing
  // and Replay integrations are HEAVY (~25 KB and ~75 KB gzip respectively)
  // and are referenced from sentry.ts only inside flag-gated branches —
  // when these are false, the integrations get tree-shaken out entirely.
  define: {
    __SENTRY_TRACING__:
      JSON.stringify(process.env.VITE_SENTRY_TRACES === '1'),
    __SENTRY_DEBUG__: 'false',
    __PICKYUM_SENTRY_REPLAY__:
      JSON.stringify(process.env.VITE_SENTRY_REPLAY === '1'),
    __PICKYUM_SENTRY_TRACES__:
      JSON.stringify(process.env.VITE_SENTRY_TRACES === '1'),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-redux': ['@reduxjs/toolkit', 'react-redux'],
          'vendor-ui':   ['@headlessui/react', '@heroicons/react'],
          // Maps lib is only imported by SearchPage / RestaurantPage (both
          // lazy routes). Splitting it explicitly keeps it from leaking into
          // the entry's modulepreload manifest, and gives it a stable name
          // (the default name "index.modern" derives from the package's
          // entry file and is fragile across upgrades).
          'vendor-maps': ['@vis.gl/react-google-maps'],
        },
      },
    },
  },
  resolve: {
    // Ensure a single copy of these packages resolves from the project root,
    // preventing the global ~/node_modules copy from being picked up in tests.
    dedupe: ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit'],
  },
  // Pre-bundle deps whose only consumers are lazy-loaded routes / components.
  // Without this, Vite first encounters them when the lazy chunk resolves,
  // triggers a background re-prebundle, and the in-flight dynamic import
  // fails with a 504 "Outdated Optimize Dep" before the new prebundle is
  // ready. Includes here:
  //   - @supabase/auth-js: imported only from src/lib/supabase.ts, which
  //     is pulled in by AuthenticationPage + OAuthCallbackPage (lazy).
  //   - @sentry/react: fully dynamic-imported via initSentry().
  //   - @vis.gl/react-google-maps: imported by NearbyMap/CompareMap, both
  //     of which were converted to React.lazy in the perf pass.
  optimizeDeps: {
    include: ['@supabase/auth-js', '@sentry/react', '@vis.gl/react-google-maps'],
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
} as ViteUserConfigWithTest)
