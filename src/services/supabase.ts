import { createClient } from '@supabase/supabase-js';
import { extractEdgeFunctionErrorMessage } from '@/utils/edgeFunctionError';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Create a .env file with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const STORAGE_BASE_URL = supabaseUrl + '/storage/v1';

/**
 * Every call site in this codebase used to do `supabase.functions.invoke` +
 * `if (error) throw error`, which always surfaced supabase-js's generic
 * "Edge Function returned a non-2xx status code" instead of the function's real error
 * message (see extractEdgeFunctionErrorMessage for why). Use this helper instead so the
 * real message actually reaches the user.
 */
export async function invokeEdgeFunction<T = any>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw new Error(await extractEdgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data as T;
}
