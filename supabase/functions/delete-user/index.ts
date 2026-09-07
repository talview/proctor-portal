// Admin-only: permanently remove a user account. Requires the service role since deleting
// from auth.users can't be done with a regular RLS-governed client call. The caller's
// identity is verified server-side from their own session JWT, same pattern as invite-user.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const callerToken = authHeader.replace('Bearer ', '')
    const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(callerToken)
    if (callerError || !callerData?.user) throw new Error('Invalid session')

    const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', callerData.user.id)
      .single()
    if (callerProfileError || callerProfile?.role !== 'admin') {
      throw new Error('Only admins can delete users')
    }

    const { userId } = await req.json()
    if (!userId) throw new Error('userId is required')

    if (userId === callerData.user.id) {
      throw new Error('You cannot delete your own account')
    }

    const { data: targetProfile, error: targetError } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle()
    if (targetError) throw targetError
    if (!targetProfile) throw new Error('User not found')

    if (targetProfile.role === 'admin') {
      const { count, error: countError } = await supabaseAdmin
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
      if (countError) throw countError
      if ((count ?? 0) <= 1) {
        throw new Error('Cannot delete the last remaining admin account')
      }
    }

    // There's no FK cascade from auth.users to the public.users profile row -- delete
    // both explicitly (profile first, so we never leave an orphaned profile row if the
    // auth deletion below were to fail).
    const { error: profileDeleteError } = await supabaseAdmin.from('users').delete().eq('id', userId)
    if (profileDeleteError) throw profileDeleteError

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)
    if (deleteError) throw deleteError

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
