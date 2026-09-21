import { supabase } from "./supabaseClient";

// Called right after a successful sign-in (password grant, or switching to a
// saved account) — not from an onAuthStateChange listener, since that only
// sees events fired after it's registered, and by the time AuthGate mounts
// on the page after a redirect, the actual SIGNED_IN event has already come
// and gone.
export async function recordLoginEvent(userId: string, email: string | null) {
  try {
    const { data: roleRow } = await supabase.from("user_roles").select("full_name").eq("user_id", userId).maybeSingle();
    await supabase.from("user_login_events").insert({
      user_id: userId,
      user_name: roleRow?.full_name || email || "Пользователь",
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    });
  } catch {
    // best-effort — a failed login-history write shouldn't block sign-in
  }
}
