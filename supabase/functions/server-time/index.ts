// Returns the server's own clock -- the topbar clock and the notification
// panel's relative timestamps read this instead of the browser's local
// system clock, which can silently drift (the report that led to this: the
// topbar read a minute off from the user's own machine). No DB access, no
// auth requirement beyond the anon key the client SDK already attaches --
// this is as cheap as an edge function call gets.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  return new Response(JSON.stringify({ now: new Date().toISOString() }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  })
})
