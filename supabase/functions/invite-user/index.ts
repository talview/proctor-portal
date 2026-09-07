// Admin-only: create a new user profile (role + vendor tag). Supports two modes:
//   mode: 'invite'   -- creates a Supabase Auth invite link (via generateLink, which does
//                        NOT send Supabase's own email) and delivers it ourselves through
//                        Mailgun -- Supabase's built-in auth email is capped at 2/hour on
//                        the free plan and was unreliable; Mailgun has no such cap.
//   mode: 'password' -- creates the account with an admin-supplied or generated password,
//                        no email involved; the password is returned once to the admin
// The caller's identity is verified server-side from their own session JWT -- the client
// never gets to just claim "I'm an admin".
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendMailgunEmail } from '../_shared/nda.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const VALID_ROLES = ['admin', 'coordinator', 'vendor']

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

    // Verify the caller's own session token and look up THEIR role from the database --
    // never trust a role claim coming from the request body.
    const callerToken = authHeader.replace('Bearer ', '')
    const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(callerToken)
    if (callerError || !callerData?.user) throw new Error('Invalid session')

    const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', callerData.user.id)
      .single()
    if (callerProfileError || callerProfile?.role !== 'admin') {
      throw new Error('Only admins can create users')
    }

    const { email, role, vendorId, mode, password: suppliedPassword } = await req.json()

    if (!email || !email.includes('@')) throw new Error('A valid email is required')
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role')
    if (role === 'vendor' && !vendorId) throw new Error('vendorId is required for vendor role')
    if (!['invite', 'password'].includes(mode)) throw new Error('mode must be "invite" or "password"')

    if (role === 'vendor') {
      const { data: vendorRow, error: vendorError } = await supabaseAdmin
        .from('vendors')
        .select('id')
        .eq('id', vendorId)
        .maybeSingle()
      if (vendorError || !vendorRow) throw new Error('Selected vendor was not found')
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    if (existingProfile) throw new Error('A user with this email already exists')

    let authUserId: string
    let returnedPassword: string | undefined

    if (mode === 'invite') {
      const baseUrl = (Deno.env.get('PUBLIC_SITE_URL') || req.headers.get('origin') || 'http://localhost:3000')
        .replace(/\/$/, '')

      const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo: `${baseUrl}/accept-invite` },
      })
      if (linkError) throw new Error(`Invite failed: ${linkError.message}`)
      authUserId = linkData.user.id

      const inviteUrl = linkData.properties.action_link
      const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; background: #ffffff; color: #1f2937; font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    .header { padding: 20px 24px; border-bottom: 1px solid #e5e7eb; }
    .header h1 { margin: 0; font-size: 20px; color: #111827; }
    .content { padding: 24px; line-height: 1.6; font-size: 15px; }
    .button { display: inline-block; background: #2563eb; color: #ffffff !important; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0; }
    .link { word-break: break-all; color: #2563eb; }
    .footer { padding: 16px 24px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    .meta { margin-top: 16px; font-size: 13px; color: #4b5563; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <h1>You've been invited to Talview Proctor Portal</h1>
      </div>
      <div class="content">
        <p>Hello,</p>
        <p>An administrator has created a <strong>${role}</strong> account for you on the Talview Proctor Portal. Click below to accept the invite and set your password.</p>
        <p>
          <a href="${inviteUrl}" class="button" target="_blank" rel="noopener noreferrer">Accept Invite</a>
        </p>
        <p class="meta">If the button does not work, use this link:</p>
        <p><a href="${inviteUrl}" class="link" target="_blank" rel="noopener noreferrer">${inviteUrl}</a></p>
        <p class="meta">If you weren't expecting this invite, you can safely ignore this email.</p>
      </div>
      <div class="footer">
        Sent automatically by Talview Proctor Portal.
      </div>
    </div>
  </div>
</body>
</html>
      `
      const emailText = `You've been invited to Talview Proctor Portal.

An administrator has created a ${role} account for you. Accept your invite using the link below:
${inviteUrl}

If you weren't expecting this invite, you can safely ignore this email.

Sent automatically by Talview Proctor Portal.`

      try {
        await sendMailgunEmail(email, 'You have been invited to Talview Proctor Portal', emailHtml, emailText)
      } catch (emailError) {
        // The Auth invite user above already exists at this point (generateLink creates
        // it) even though the email failed to go out, and the `users` profile row below
        // is never reached -- but this is safe to retry: calling "Invite" again with the
        // exact same email reuses that same unconfirmed Auth user and mints a fresh
        // link (verified directly against this project), it does not error or create a
        // duplicate. Say so explicitly so an admin isn't left unsure whether retrying
        // will make things worse.
        const reason = emailError instanceof Error ? emailError.message : 'Unknown error'
        throw new Error(`Invite email failed to send (${reason}). You can safely try again with the same email.`)
      }
    } else {
      const passwordToUse = suppliedPassword || crypto.randomUUID().replace(/-/g, '').slice(0, 20)
      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: passwordToUse,
        email_confirm: true,
      })
      if (createError) throw new Error(`Account creation failed: ${createError.message}`)
      authUserId = created.user.id
      returnedPassword = passwordToUse
    }

    const { error: insertError } = await supabaseAdmin.from('users').insert({
      id: authUserId,
      username: email.split('@')[0],
      email,
      role,
      vendor_id: role === 'vendor' ? vendorId : null,
      password: '',
    })
    if (insertError) throw insertError

    return new Response(
      JSON.stringify({ success: true, userId: authUserId, mode, password: returnedPassword }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
