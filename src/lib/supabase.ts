// Supabase auth client — narrow surface
// --------------------------------------
// PickYum only uses Supabase for OAuth sign-in (`signInWithOAuth` and
// `getSession`). The umbrella `@supabase/supabase-js` package bundles auth +
// realtime + storage + postgrest + functions; pulling all of that in is
// ~206 KB raw / 53 KB gzip for two methods we use.
//
// `@supabase/auth-js` is the auth-only sub-package (already in node_modules
// as a transitive dep of supabase-js, so no install needed). Using it
// directly cuts the chunk down to just the auth client.
import { AuthClient } from '@supabase/auth-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// `AuthClient` is the same constructor `supabase-js` calls internally as
// `GoTrueClient`. It exposes `signInWithOAuth` and `getSession` with the
// exact same signatures — consumers don't need to change.
export const supabase = isSupabaseConfigured
  ? new AuthClient({
      url: `${supabaseUrl}/auth/v1`,
      headers: { apikey: supabaseAnonKey! },
      // PKCE matches Supabase's current default and is what consumers
      // expect — `getSession` auto-detects code-flow vs implicit-flow.
      flowType: 'pkce',
      autoRefreshToken: true,
      persistSession: true,
      storageKey: 'pickyum-supabase-auth',
    })
  : null;
