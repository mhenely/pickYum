/// <reference types="vite/client" />

// Build-time feature flags defined in vite.config.ts via `define`. They
// resolve to literal `true`/`false` in the output, which lets esbuild's
// dead-code eliminator strip the entire false branch — including any
// references to heavy library symbols inside that branch. Used to feature-
// flag Sentry Replay + Tracing so unused integrations never reach the
// shipped Sentry chunk.
declare const __PICKYUM_SENTRY_REPLAY__: boolean;
declare const __PICKYUM_SENTRY_TRACES__: boolean;
