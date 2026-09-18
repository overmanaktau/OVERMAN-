import { createClient } from "@supabase/supabase-js";

// Server-only client (service role key) — never import this from a "use client" file.
// Used exclusively by app/api/** route handlers to manage auth users and roles.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
