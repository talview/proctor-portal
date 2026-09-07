// Pulled out of src/services/supabase.ts so it can be unit tested without pulling in
// the real Supabase client (which needs env vars at import time) or the global test
// mock of that module.
//
// Every edge function in this app reports business errors by throwing (see
// errorResponse() in supabase/functions/_shared/nda.ts), which always replies with a
// non-2xx status. supabase-js turns that into a FunctionsHttpError whose `.message` is
// hardcoded to the generic "Edge Function returned a non-2xx status code" -- the
// actual `{error: "..."}` body is only reachable via `error.context`, the raw Response
// object. This resolves the real message from that context, falling back to the
// generic supabase-js message if the context can't be read as JSON.
export async function extractEdgeFunctionErrorMessage(error: { message: string; context?: unknown }): Promise<string> {
  const context = error.context as { json?: () => Promise<any>; clone?: () => { json: () => Promise<any> } } | undefined;
  if (context && typeof context.json === 'function') {
    try {
      const source = typeof context.clone === 'function' ? context.clone() : context;
      const parsed = await source.json!();
      if (parsed?.error) return parsed.error;
    } catch {
      // context body wasn't JSON (or was already consumed) -- fall through
    }
  }
  return error.message;
}
