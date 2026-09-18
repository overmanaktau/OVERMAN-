// Supabase/PostgREST errors are plain {message, code, ...} objects, not
// instances of Error — so `e instanceof Error` misses them and falls back
// to "[object Object]". This checks for a `.message` field too.
export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}
