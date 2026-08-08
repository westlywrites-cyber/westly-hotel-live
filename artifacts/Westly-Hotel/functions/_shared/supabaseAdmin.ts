// ══════════════════════════════════════════════════════════════════════════
// Shared Supabase service-role client for Cloudflare Pages Functions.
// This is the ONLY place SUPABASE_SERVICE_ROLE_KEY is touched — never import
// this from client code. The service-role key bypasses Row Level Security
// entirely, so every function that uses it MUST gate the caller first with
// requireActiveUser()/requireSuperAdmin() (see ./admin.ts) before doing
// anything with the client this returns.
//
// SUPABASE_URL is intentionally read from the same VITE_SUPABASE_URL value
// already configured for the client bundle (see src/lib/supabase.ts) — it
// is a public project URL, not a secret, and Cloudflare Pages exposes every
// configured environment variable (regardless of VITE_ prefix) to Pages
// Functions at request time, so no separate/duplicate variable is needed.
// Only the service-role key itself is a new, server-only secret.
// ══════════════════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseEnv {
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  [key: string]: unknown;
}

let cachedClient: SupabaseClient | null = null;
let cachedForKey: string | null = null;

/**
 * Returns a Supabase client authenticated with the service-role key, or
 * null if the project isn't configured yet in this environment (e.g. a
 * preview deploy before the secret is set) — callers should turn a null
 * return into a clear 500 ("Message service is not configured" / etc.)
 * rather than throwing an unhandled exception.
 */
export function getSupabaseServiceClient(env: SupabaseEnv): SupabaseClient | null {
  const url = env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  // Reuse the cached client across requests in the same isolate unless the
  // key has changed (e.g. between test runs) — createClient() is cheap but
  // there's no reason to redo it every call.
  if (cachedClient && cachedForKey === serviceRoleKey) return cachedClient;

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedForKey = serviceRoleKey;
  return cachedClient;
}
