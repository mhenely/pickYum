import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';

// Client-side feature flag state, mirroring `FeatureFlags` from
// server/src/lib/flags.ts. The client fetches /api/flags once on app
// boot; the values stay in Redux for the session and don't change
// unless the user reloads.
//
// Why a Redux slice (not React context):
//   - Components that aren't in a provider tree (e.g. error boundary
//     fallbacks, modal portals) can still read flags.
//   - The values participate in DevTools serialization — easy to see
//     what was active when a bug repro'd.
//
// Until /api/flags lands, every flag reads as its `defaults` value
// below. Same defaults the server uses — keep the two in lockstep.
//
// Adding a flag (TIER_2_3_PLAN.md #15):
//   1. Add key + default to `defaultFlags` here.
//   2. Add same key + same default to server/src/lib/flags.ts.
//   3. Use `useFlag('myFlag')` from src/hooks/useFlag.ts to gate UI.

export interface FeatureFlags {
  newDetailModal: boolean;
  insightsOptOutVisible: boolean;
  backgroundRefresh: boolean;
  strictApiSchemaValidation: boolean;
}

export const defaultFlags: FeatureFlags = {
  newDetailModal:            false,
  insightsOptOutVisible:     true,
  backgroundRefresh:         false,
  strictApiSchemaValidation: true,
};

interface FlagsState {
  values: FeatureFlags;
  loaded: boolean;
}

const initialState: FlagsState = {
  values: defaultFlags,
  loaded: false,
};

export const loadFlags = createAsyncThunk('flags/load', async () => {
  // Direct fetch — no api.ts dependency to avoid a cycle if api.ts ever
  // needs to read flags during its own boot (zod strictness, etc).
  // Direct `import.meta.env.X` form (not via a cast) so Vite's static
  // env replacement recognizes the access and bakes the value in at
  // build time. The previous cast-via-unknown form defeated the static
  // replacement and the bundle always fell through to the localhost
  // fallback in production.
  const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/flags`, { credentials: 'include' });
  if (!res.ok) throw new Error(`flags fetch failed: ${res.status}`);
  const body = await res.json() as { flags: Partial<FeatureFlags> };
  return body.flags;
});

const flagsSlice = createSlice({
  name: 'flags',
  initialState,
  reducers: {
    // Manual override — useful in tests or in a dev-mode "flag panel"
    // we haven't built yet. Patch one or more flags without a refetch.
    setFlags: (state, action: PayloadAction<Partial<FeatureFlags>>) => {
      state.values = { ...state.values, ...action.payload };
    },
  },
  extraReducers: (builder) => {
    builder.addCase(loadFlags.fulfilled, (state, action) => {
      // Merge with defaults so missing keys (server using an older
      // schema than the client) stay at their safe default rather
      // than becoming undefined.
      state.values = { ...defaultFlags, ...action.payload };
      state.loaded = true;
    });
    builder.addCase(loadFlags.rejected, (state) => {
      // Fail-open: keep defaults, log nothing here (the global error
      // boundary will pick it up). Flag fetch failing must not block
      // the rest of the app from booting.
      state.loaded = true;
    });
  },
});

export const { setFlags } = flagsSlice.actions;
export default flagsSlice.reducer;
