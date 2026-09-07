// Shared helpers for the NDA e-signature edge functions. Bundled per-function by the
// Supabase CLI at deploy time (standard `_shared` convention -- not a separate deployment).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacHex(keyMaterial: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Opaque, unguessable tokens -- the plaintext is only ever seen by the recipient
// (in the emailed link / OTP), never stored. Only the hash is persisted.
export function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateOtp(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const n = new DataView(bytes.buffer).getUint32(0)
  return (n % 1000000).toString().padStart(6, '0')
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token))
}

/**
 * OTPs are only 6 digits (1,000,000 possible values) -- unlike the 32-byte random
 * session/step tokens hashToken() is otherwise used for, a bare SHA-256 of an OTP is
 * fully reversible from a leaked hash by precomputing all 1,000,000 candidates once.
 * HMAC-ing with a server-side secret (never itself stored in the database) makes that
 * precomputation attack impossible without also compromising OTP_HASH_PEPPER.
 */
export async function hashOtp(otp: string): Promise<string> {
  const pepper = Deno.env.get('OTP_HASH_PEPPER')
  if (!pepper) throw new Error('Server misconfiguration: OTP_HASH_PEPPER is not set')
  return hmacHex(pepper, otp)
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// IP/UA must always come from here, never from the request body -- the whole point
// of the audit trail is that the client can't assert its own evidence.
export function getClientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('cf-connecting-ip') || null
}

export function getUserAgent(req: Request): string | null {
  return req.headers.get('user-agent')
}

/** Verifies the caller's session JWT belongs to an admin. Throws otherwise. */
export async function requireAdminCaller(req: Request, supabase: ReturnType<typeof adminClient>) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new Error('Missing Authorization header')

  const callerToken = authHeader.replace('Bearer ', '')
  const { data: callerData, error: callerError } = await supabase.auth.getUser(callerToken)
  if (callerError || !callerData?.user) throw new Error('Invalid session')

  const { data: callerProfile, error: profileError } = await supabase
    .from('users')
    .select('role, username, email')
    .eq('id', callerData.user.id)
    .single()

  if (profileError || callerProfile?.role !== 'admin') {
    throw new Error('Only admins can perform this action')
  }

  return { id: callerData.user.id, ...callerProfile }
}

/**
 * Appends any number of events to the append-only audit log in a single DB
 * round-trip via `log_nda_events_batch` (server-side computes the next `seq`
 * once and inserts every row in one INSERT ... SELECT, under an advisory lock
 * scoped to this session -- see migration 0034 for the full rationale).
 */
export async function logEventsBatch(
  supabase: ReturnType<typeof adminClient>,
  sessionId: string,
  req: Request | null,
  events: { eventType: string; detail?: Record<string, unknown> }[]
) {
  if (events.length === 0) return
  const { error } = await supabase.rpc('log_nda_events_batch', {
    p_session_id: sessionId,
    p_ip_address: req ? getClientIp(req) : null,
    p_user_agent: req ? getUserAgent(req) : null,
    p_events: events.map((e) => ({ event_type: e.eventType, detail: e.detail ?? {} })),
  })
  if (error) throw error
}

/** Single-event convenience wrapper around `logEventsBatch`. */
export async function logEvent(
  supabase: ReturnType<typeof adminClient>,
  sessionId: string,
  eventType: string,
  req: Request | null,
  detail: Record<string, unknown> = {}
) {
  await logEventsBatch(supabase, sessionId, req, [{ eventType, detail }])
}

/**
 * Compare-and-swap status update: only succeeds if the row's current status is
 * one of `fromStatuses`. Used everywhere a status transition must never race
 * (a double-click or retried request can't produce two signed artifacts, etc.)
 */
export async function casUpdate(
  supabase: ReturnType<typeof adminClient>,
  sessionId: string,
  fromStatuses: string[],
  toStatus: string,
  extra: Record<string, unknown> = {}
) {
  const { data } = await supabase
    .from('nda_signing_sessions')
    .update({ status: toStatus, ...extra })
    .eq('id', sessionId)
    .in('status', fromStatuses)
    .select('id')
  return (data?.length ?? 0) > 0
}

export async function sendMailgunEmail(to: string, subject: string, html: string, text: string) {
  const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN')
  const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY')
  if (!mailgunDomain || !mailgunApiKey) throw new Error('Mailgun not configured')

  const formData = new FormData()
  formData.append('from', `Talview Proctor Portal <noreply@${mailgunDomain}>`)
  formData.append('to', to)
  formData.append('subject', subject)
  formData.append('html', html)
  formData.append('text', text)
  formData.append('o:tracking-opens', 'no')
  formData.append('o:tracking-clicks', 'no')

  const replyTo = Deno.env.get('MAILGUN_REPLY_TO')
  if (replyTo) formData.append('h:Reply-To', replyTo)

  const res = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`api:${mailgunApiKey}`)}` },
    body: formData,
  })

  if (!res.ok) {
    const errorText = await res.text()
    console.error('Mailgun error:', errorText)
    // Surface Mailgun's actual reason (e.g. a daily send-limit or an invalid recipient)
    // rather than a fixed generic string -- this is what ends up in
    // bulk_dispatch_items.failure_reason, and a generic message there gives an admin no
    // way to tell "retry this" apart from "this will never succeed until tomorrow."
    let reason = `Mailgun error (${res.status})`
    try {
      const parsed = JSON.parse(errorText)
      if (parsed?.message) reason = parsed.message
    } catch {
      // errorText wasn't JSON -- keep the generic status-coded reason above
    }
    throw new Error(reason)
  }
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  })
}

export function errorResponse(error: unknown, status = 400) {
  // `error instanceof Error` alone is fragile here: Postgrest/Storage errors thrown by
  // supabase-js (an esm.sh bundle) don't always satisfy a cross-realm `instanceof Error`
  // check, which silently collapsed real error messages down to "Unknown error". Fall
  // back to any `.message` string the thrown value carries before giving up.
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && typeof (error as any).message === 'string'
        ? (error as any).message
        : 'Unknown error'
  console.error('NDA function error:', error)
  return jsonResponse({ error: message }, status)
}

/** Validates a step token (minted by verify-otp) and returns the session row. */
export async function requireStepToken(
  supabase: ReturnType<typeof adminClient>,
  stepToken: string,
  allowedStatuses: string[]
) {
  if (!stepToken) throw new Error('stepToken is required')
  const stepTokenHash = await hashToken(stepToken)

  const { data: session, error } = await supabase
    .from('nda_signing_sessions')
    .select('*')
    .eq('step_token_sha256', stepTokenHash)
    .maybeSingle()

  if (error || !session) throw new Error('Invalid or expired session')
  if (!session.step_token_expires_at || new Date(session.step_token_expires_at) < new Date()) {
    throw new Error('Your session has expired. Please verify your code again.')
  }
  // Defense in depth against the "started before the deadline, finished after" edge
  // case: a same_day-policy session's step token (45 min) can still be valid past
  // session_expires_at (23:59:59 that day). nda-session-status already reports
  // status:'expired' at page-load/resume time, but that's advisory -- this is the
  // actual enforcement point for every action that touches a live session.
  if (session.session_expires_at && new Date(session.session_expires_at) < new Date()) {
    throw new Error('Your signing window has expired. Please ask your coordinator to resend the link.')
  }
  if (!allowedStatuses.includes(session.status)) {
    throw new Error(`This action isn't available for a session in status "${session.status}"`)
  }
  return session
}

/**
 * Converts a field rect (normalized 0..1, top-left origin, against the *visual*
 * page box the admin saw when mapping fields) into raw PDF user-space coordinates
 * (bottom-left origin) for pdf-lib's drawImage/drawText.
 *
 * Only unrotated pages (/Rotate 0) are supported -- the overwhelming majority of
 * flat, Word-exported NDA PDFs never set page rotation, and getting the rotated-page
 * transform subtly wrong on a legal document is worse than refusing clearly. If a
 * rotated template is ever needed, extend this function rather than guess.
 */
export function fieldRectToPdfSpace(
  field: { x: number; y: number; w: number; h: number; page_w: number; page_h: number; page_rotation: number },
  rawWidth: number,
  rawHeight: number,
  actualRotation: number
): { x: number; y: number; width: number; height: number } {
  if (actualRotation % 360 !== 0) {
    throw new Error('This NDA template page has a rotation this version does not support')
  }
  if (Math.abs(rawWidth - field.page_w) > 1 || Math.abs(rawHeight - field.page_h) > 1) {
    throw new Error('The template PDF page dimensions no longer match how its fields were mapped')
  }

  const x = field.x * rawWidth
  const width = field.w * rawWidth
  const height = field.h * rawHeight
  const y = rawHeight - field.y * rawHeight - height
  return { x, y, width, height }
}

/**
 * Resolves an nda_templates.expiry_policy into the actual session_expires_at instant,
 * computed from `from` (normally "now"). India Standard Time has no DST, so the fixed
 * +5:30 offset arithmetic below is exact (unlike most timezones, this can't be done
 * safely with a shifted-then-read-UTC-fields trick if DST were in play).
 *
 * '24h': unchanged flat 24-hour window (the only behavior that existed before this
 * policy was configurable).
 * 'same_day': 23:59:59.999 IST of the same calendar day `from` falls on in IST. This is
 * deliberately a hard deadline, not a grace window -- see the expiry check in
 * nda-session-submit's handleSign, which is what actually enforces it against the
 * "started before midnight, finished after" edge case.
 */
export function resolveSessionExpiry(policy: string, from: Date): Date {
  if (policy === '24h') {
    const d = new Date(from)
    d.setHours(d.getHours() + 24)
    return d
  }
  if (policy === 'same_day') {
    const istWall = new Date(from.getTime() + IST_OFFSET_MS)
    const endOfDayIstWallMs = Date.UTC(
      istWall.getUTCFullYear(),
      istWall.getUTCMonth(),
      istWall.getUTCDate(),
      23, 59, 59, 999
    )
    return new Date(endOfDayIstWallMs - IST_OFFSET_MS)
  }
  throw new Error(`Unknown expiry_policy: ${policy}`)
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function istParts(d: Date) {
  const istWall = new Date(d.getTime() + IST_OFFSET_MS)
  return {
    year: istWall.getUTCFullYear(),
    month: istWall.getUTCMonth(),
    day: istWall.getUTCDate(),
    hours: istWall.getUTCHours(),
    minutes: istWall.getUTCMinutes(),
    seconds: istWall.getUTCSeconds(),
  }
}

/**
 * "06 Sep 2026" -- the calendar day is IST (not UTC), and the month is a hardcoded
 * 3-letter abbreviation rather than Intl/toLocaleDateString, since ICU's short-month
 * form for en-GB varies by environment ("Sep" vs "Sept") and this exact string is
 * drawn onto a legal document -- it must render identically everywhere, not just be
 * "close enough". No signature-law regime (ESIGN/UETA, eIDAS, India's IT Act 2000)
 * mandates a specific date format; this format is chosen because it's unambiguous
 * (unlike MM/DD/YYYY vs DD/MM/YYYY), not because any of them require it.
 */
export function formatIstDate(d: Date): string {
  const p = istParts(d)
  return `${String(p.day).padStart(2, '0')} ${MONTH_ABBR[p.month]} ${p.year}`
}

/** Same date format plus a time-of-day, explicitly labeled IST -- used on the audit page. */
export function formatIstDateTime(d: Date): string {
  const p = istParts(d)
  const time = `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')}`
  return `${formatIstDate(d)}, ${time} IST`
}

/**
 * Writes directly to audit_log, bypassing the log_audit() RPC -- that RPC derives
 * `usr` from auth.jwt(), which assumes an authenticated staff session. These
 * anonymous, public-facing flows (an external candidate verifying an OTP with no
 * Supabase session at all) have no such session, so this inserts with the service
 * role instead (which always bypasses RLS) and takes the actor label explicitly.
 * Not NDA-specific despite living in this file -- shared here because callers of
 * this module already need the other crypto helpers alongside it.
 */
export async function logAuditEntry(
  supabase: ReturnType<typeof adminClient>,
  actor: string,
  action: string,
  target: string,
  detail: string
) {
  const { error } = await supabase.from('audit_log').insert({
    id: crypto.randomUUID(),
    usr: actor,
    action,
    target,
    detail,
  })
  if (error) console.error('audit_log write failed:', error)
}

export const DOC_KINDS = [
  'resume',
  'passport_photo',
  'grad_cert',
  'aadhaar_copy',
  'pan_copy',
  'eye_test',
] as const
export type DocKind = (typeof DOC_KINDS)[number]

export const DOC_KIND_TO_COLUMN: Record<DocKind, string> = {
  resume: 'doc_resume',
  passport_photo: 'doc_passport_photo',
  grad_cert: 'doc_grad_cert',
  aadhaar_copy: 'doc_aadhaar_copy',
  pan_copy: 'doc_pan_copy',
  eye_test: 'doc_eye_test',
}
