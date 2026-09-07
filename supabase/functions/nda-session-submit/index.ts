// The two irreversible steps of the flow:
//   action:"sign"     otp_verified/consented -> signing -> signed (in the background).
//                      Logs consent + one event per field in a single batched DB call,
//                      CAS-locks the session into "signing", and returns immediately --
//                      the actual template download/field-drawing/upload runs afterward
//                      via EdgeRuntime.waitUntil so the signer isn't blocked on it and
//                      can move straight to the Document Upload step. "signing" accepts
//                      document uploads too (see nda-session-upload-url), so there's no
//                      dead time even if rendering takes a moment.
//   action:"finalize" signed -> completed, once all 6 documents are confirmed present
//                      AND the background-rendered signed PDF is ready (it briefly polls
//                      for the latter if the signer finished uploading unusually fast).
//                      Generates the audit certificate and the HMAC evidence tag.
// Both use a compare-and-swap status update (not read-then-check) so a double-click
// or retried request can never produce two signed artifacts for one session.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1?target=deno'
import {
  adminClient,
  requireStepToken,
  logEvent,
  logEventsBatch,
  casUpdate,
  sha256Hex,
  hmacHex,
  fieldRectToPdfSpace,
  formatIstDate,
  formatIstDateTime,
  jsonResponse,
  errorResponse,
  corsHeaders,
  DOC_KINDS,
  DOC_KIND_TO_COLUMN,
} from '../_shared/nda.ts'

// Not a standard TS/Deno global -- injected by Supabase's edge-runtime specifically for
// this "return the response now, keep running" pattern. See supabase.com/docs/guides/functions/background-tasks.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

function base64ToBytes(dataUrlOrBase64: string): Uint8Array {
  const base64 = dataUrlOrBase64.includes(',') ? dataUrlOrBase64.split(',')[1] : dataUrlOrBase64
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Downloads the template once, draws every field + the Doc ID footer, uploads the
 * result, and marks the session "signed" -- entirely after the client already has its
 * response. Any failure here is recorded on the session (`render_error`) rather than
 * thrown into the void, so handleFinalize's poll can surface a real message instead of
 * the signer's upload step hanging forever against a session that quietly failed.
 */
async function renderAndUploadSignedPdf(
  supabase: ReturnType<typeof adminClient>,
  session: any,
  template: any,
  signatureBytes: Uint8Array,
  textValues: Record<string, string>
) {
  try {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(template.storage_bucket)
      .download(template.storage_path)
    if (downloadError || !fileData) throw new Error('Could not read the NDA template')

    const templateBytes = new Uint8Array(await fileData.arrayBuffer())
    const actualHash = await sha256Hex(templateBytes)
    if (actualHash !== session.template_sha256) {
      throw new Error('The NDA template has changed since this session was created. Contact your coordinator.')
    }

    const pdfDoc = await PDFDocument.load(templateBytes)
    const signatureImage = await pdfDoc.embedPng(signatureBytes)
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

    const todayStr = formatIstDate(new Date())

    for (const field of template.field_map as any[]) {
      const page = pdfDoc.getPage(field.page_index)
      const { width: rawWidth, height: rawHeight } = page.getSize()
      const rotation = page.getRotation().angle
      const rect = fieldRectToPdfSpace(field, rawWidth, rawHeight, rotation)

      if (field.kind === 'signature') {
        const imgDims = signatureImage.scale(1)
        const scale = Math.min(rect.width / imgDims.width, rect.height / imgDims.height)
        const drawW = imgDims.width * scale
        const drawH = imgDims.height * scale
        page.drawImage(signatureImage, {
          x: rect.x + (rect.width - drawW) / 2,
          y: rect.y + (rect.height - drawH) / 2,
          width: drawW,
          height: drawH,
        })
      } else {
        const text =
          field.kind === 'date' ? todayStr :
          field.kind === 'full_name' ? session.signer_name_snapshot :
          field.kind === 'text' ? String(textValues[field.label] || '') : ''
        if (text) {
          const size = Math.max(6, Math.min(rect.height * 0.7, 11))
          page.drawText(text, { x: rect.x, y: rect.y + rect.height * 0.15, size, font, color: rgb(0.1, 0.1, 0.1) })
        }
      }
    }

    // Doc ID footer on every page (not just pages with a field), matching the reference
    // signing tool's per-page tracking stamp -- a lightweight visual/traceability marker,
    // independent of the evidence HMAC computed later in handleFinalize.
    const docId = (await sha256Hex(new TextEncoder().encode(`${session.id}:docid`))).slice(0, 32)
    const timestamp = formatIstDateTime(new Date())
    const stamp = `Doc ID: ${docId}  ·  Signed by ${session.signer_name_snapshot}  ·  ${timestamp}`
    const stampSize = 6
    const stampWidth = font.widthOfTextAtSize(stamp, stampSize)
    for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
      const page = pdfDoc.getPage(pageIndex)
      const { width: pageWidth } = page.getSize()
      page.drawText(stamp, {
        x: Math.max(24, (pageWidth - stampWidth) / 2),
        y: 14,
        size: stampSize,
        font,
        color: rgb(0.4, 0.4, 0.4),
      })
    }

    // Self-check against the in-memory doc -- drawing never changes page count, so this
    // never needs to reload the just-saved bytes to verify (unlike the old version).
    if (pdfDoc.getPageCount() !== template.page_count) {
      throw new Error('Signed PDF generation produced an unexpected page count -- aborting')
    }

    const signedBytes = await pdfDoc.save()
    const signedPdfSha256 = await sha256Hex(signedBytes)
    const signedPdfPath = `sessions/${session.id}/signed-nda.pdf`

    const { error: uploadError } = await supabase.storage
      .from('nda-signing')
      .upload(signedPdfPath, signedBytes, { contentType: 'application/pdf', upsert: true })
    if (uploadError) throw uploadError

    await logEvent(supabase, session.id, 'signed_pdf_generated', null, { sha256: signedPdfSha256 })

    const { error: sessionUpdateError } = await supabase
      .from('nda_signing_sessions')
      .update({
        status: 'signed',
        signed_pdf_path: signedPdfPath,
        signed_pdf_sha256: signedPdfSha256,
      })
      .eq('id', session.id)
    if (sessionUpdateError) throw sessionUpdateError

    const { error: proctorUpdateError } = await supabase
      .from('proctors')
      .update({
        nda_status: 'NDA Signed',
        nda_signed_at: new Date().toISOString(),
        nda_file_url: signedPdfPath,
        upd: new Date().toISOString(),
      })
      .eq('id', session.proctor_id)
    if (proctorUpdateError) throw proctorUpdateError
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error generating the signed document'
    console.error('renderAndUploadSignedPdf failed:', error)
    try {
      await supabase.from('nda_signing_sessions').update({ render_error: message }).eq('id', session.id)
      await logEvent(supabase, session.id, 'signed_pdf_generation_failed', null, { message })
    } catch (loggingError) {
      console.error('Failed to record render_error:', loggingError)
    }
  }
}

async function handleSign(supabase: ReturnType<typeof adminClient>, req: Request, body: any) {
  const session = await requireStepToken(supabase, body.stepToken, ['otp_verified', 'consented', 'signed'])

  // Idempotent: if this session already finished signing (e.g. a retried request
  // after the client didn't see the response), just return success again.
  if (session.status === 'signed') {
    return jsonResponse({ success: true, alreadySigned: true })
  }

  if (!body.signatureImageBase64) throw new Error('signatureImageBase64 is required')

  // CAS lock first, before any logging or rendering work -- exactly like the original
  // flow -- so a lost race (concurrent double-click/retry) never double-logs events for
  // the request that lost.
  const won = await casUpdate(supabase, session.id, ['otp_verified', 'consented'], 'signing')
  if (!won) {
    // Someone else's concurrent request won the race -- re-check final state.
    const { data: fresh } = await supabase
      .from('nda_signing_sessions')
      .select('status')
      .eq('id', session.id)
      .single()
    if (fresh?.status === 'signed' || fresh?.status === 'signing') {
      return jsonResponse({ success: true })
    }
    throw new Error('This session is being processed by another request. Please retry shortly.')
  }

  const { data: template, error: templateError } = await supabase
    .from('nda_templates')
    .select('*')
    .eq('id', session.template_id)
    .single()
  if (templateError || !template) throw new Error('Template not found')

  // Consent (viewed + the explicit agreement) is one user action together with signing
  // -- logged every call, matching the previous nda-session-consent behavior -- plus one
  // event per template field, all in the single batched call this replaces two-plus-2N
  // sequential round-trips with.
  const textValues = (body.textValues && typeof body.textValues === 'object') ? body.textValues : {}
  const fieldEvents = (template.field_map as any[]).map((field) => ({
    eventType: 'field_signed',
    detail: { field_key: field.field_key, kind: field.kind },
  }))
  await logEventsBatch(supabase, session.id, req, [
    { eventType: 'nda_viewed', detail: { viewed_to_end: !!body.viewedToEnd } },
    { eventType: 'consent_given' },
    ...fieldEvents,
  ])

  const signatureBytes = base64ToBytes(body.signatureImageBase64)
  EdgeRuntime.waitUntil(renderAndUploadSignedPdf(supabase, session, template, signatureBytes, textValues))

  return jsonResponse({ success: true })
}

async function handleFinalize(supabase: ReturnType<typeof adminClient>, req: Request, body: any) {
  let session = await requireStepToken(supabase, body.stepToken, ['signing', 'signed', 'completed'])

  if (session.status === 'completed') {
    return jsonResponse({ success: true, alreadyCompleted: true })
  }

  let docs = (
    await supabase
      .from('nda_session_documents')
      .select('doc_kind, storage_path, content_sha256, byte_size, integrity_status')
      .eq('session_id', session.id)
  ).data

  const uploaded = new Set((docs || []).map((d) => d.doc_kind))
  const missing = DOC_KINDS.filter((k) => !uploaded.has(k))
  if (missing.length > 0) {
    throw new Error(`Missing documents: ${missing.join(', ')}`)
  }

  const stillVerifyingDocs = () => (docs || []).some((d) => d.integrity_status === 'pending')

  // Background PDF rendering (kicked off by handleSign) usually finishes in well under
  // a second now that it's not paying for N sequential audit-log round-trips -- long
  // before a signer finishes uploading 6 documents. Likewise, each document's
  // background integrity verification (see nda-session-upload-url) usually finishes
  // well before all 6 are uploaded and Submit is pressed. This only actually waits in
  // the rare case either one is still running.
  if (session.status === 'signing' || stillVerifyingDocs()) {
    if (session.render_error) throw new Error(session.render_error)

    let stillWaiting = true
    for (let attempt = 0; attempt < 10 && stillWaiting; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const { data: fresh } = await supabase
        .from('nda_signing_sessions')
        .select('*')
        .eq('id', session.id)
        .single()
      if (!fresh) throw new Error('Session not found')
      if (fresh.render_error) throw new Error(fresh.render_error)
      session = fresh

      const { data: freshDocs } = await supabase
        .from('nda_session_documents')
        .select('doc_kind, storage_path, content_sha256, byte_size, integrity_status')
        .eq('session_id', session.id)
      docs = freshDocs

      stillWaiting = session.status === 'signing' || stillVerifyingDocs()
    }

    if (stillWaiting) {
      return jsonResponse({ success: false, stillProcessing: true })
    }
  }

  const mismatched = (docs || []).filter((d) => d.integrity_status === 'mismatch').map((d) => d.doc_kind)
  if (mismatched.length > 0) {
    throw new Error(`These documents failed verification and must be re-uploaded: ${mismatched.join(', ')}`)
  }

  const won = await casUpdate(supabase, session.id, ['signed'], 'completed')
  if (!won) {
    const { data: fresh } = await supabase.from('nda_signing_sessions').select('status').eq('id', session.id).single()
    if (fresh?.status === 'completed') return jsonResponse({ success: true, alreadyCompleted: true })
    throw new Error('This session is being processed by another request. Please retry shortly.')
  }

  const { data: events } = await supabase
    .from('nda_signing_events')
    .select('seq, event_type, occurred_at, ip_address, user_agent, detail')
    .eq('session_id', session.id)
    .order('seq', { ascending: true })

  const certDoc = await PDFDocument.create()
  const font = await certDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await certDoc.embedFont(StandardFonts.HelveticaBold)
  let page = certDoc.addPage([612, 792])
  let cursorY = 750

  const drawLine = (text: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) => {
    const size = opts.size ?? 10
    if (cursorY < 60) {
      page = certDoc.addPage([612, 792])
      cursorY = 750
    }
    page.drawText(text, { x: 48, y: cursorY, size, font: opts.bold ? boldFont : font, color: rgb(0.1, 0.1, 0.1) })
    cursorY -= (opts.gap ?? size + 6)
  }

  drawLine('NDA Signing Audit Certificate', { size: 18, bold: true, gap: 28 })
  drawLine(`Session ID: ${session.id}`, { size: 9 })
  drawLine(`Signer: ${session.signer_name_snapshot} <${session.signer_email_snapshot}>`, { size: 9 })
  drawLine(`Template SHA-256: ${session.template_sha256}`, { size: 8 })
  drawLine(`Signed PDF SHA-256: ${session.signed_pdf_sha256}`, { size: 8, gap: 20 })

  drawLine('Documents submitted:', { bold: true, gap: 16 })
  for (const d of docs || []) {
    drawLine(`  ${d.doc_kind}: ${d.content_sha256.slice(0, 16)}... (${d.byte_size} bytes)`, { size: 8 })
  }

  drawLine('Event log:', { bold: true, gap: 16 })
  for (const e of events || []) {
    drawLine(
      `  #${e.seq} ${e.event_type} at ${e.occurred_at} from ${e.ip_address || 'unknown'} (${(e.user_agent || 'unknown').slice(0, 60)})`,
      { size: 7, gap: 11 }
    )
  }

  drawLine('Certificate scope', { bold: true, gap: 16 })
  const disclaimer = [
    'This certificate records the electronic signing activity and related audit',
    'information for this document. It does not independently verify the signer\'s',
    'legal identity beyond the authentication methods used in this signing process.',
    'The legal effect and enforceability of an electronic signature may depend on',
    'applicable laws and circumstances.',
  ]
  for (const line of disclaimer) drawLine(line, { size: 8 })

  const certBytesUnsigned = await certDoc.save()
  const canonicalPayload = JSON.stringify({
    sessionId: session.id,
    templateSha256: session.template_sha256,
    signedPdfSha256: session.signed_pdf_sha256,
    documents: (docs || []).map((d) => ({ kind: d.doc_kind, sha256: d.content_sha256, bytes: d.byte_size })),
    events: (events || []).map((e) => ({ seq: e.seq, type: e.event_type, at: e.occurred_at, ip: e.ip_address, ua: e.user_agent })),
  })
  const hmacSecret = Deno.env.get('NDA_HMAC_SECRET')
  if (!hmacSecret) throw new Error('Server misconfiguration: NDA_HMAC_SECRET is not set')
  const evidenceHmac = await hmacHex(hmacSecret, canonicalPayload)

  drawLine('', { gap: 10 })
  drawLine(`Evidence HMAC: ${evidenceHmac}`, { size: 8, bold: true })

  const certBytes = await certDoc.save()
  const certificateSha256 = await sha256Hex(certBytes)
  const certificatePath = `sessions/${session.id}/certificate.pdf`

  const { error: certUploadError } = await supabase.storage
    .from('nda-signing')
    .upload(certificatePath, certBytes, { contentType: 'application/pdf', upsert: true })
  if (certUploadError) throw certUploadError

  // Append a condensed, Dropbox-Sign-style one-page audit summary as the actual last
  // page of the downloadable signed PDF itself -- certificate.pdf above stays the
  // separate, detailed HMAC'd evidence artifact; this is additionally what a signer
  // sees when they just open the document they signed. Done here (not in handleSign)
  // because this is the point where the full event log, including document uploads,
  // actually exists -- this is the one PDF round-trip that's structurally unavoidable
  // in a "sign now, finish later" flow, not leftover redundant work.
  const { data: template } = await supabase
    .from('nda_templates')
    .select('page_count, label, storage_path')
    .eq('id', session.template_id)
    .single()

  const { data: signedFileData, error: signedDownloadError } = await supabase.storage
    .from('nda-signing')
    .download(session.signed_pdf_path)
  if (signedDownloadError || !signedFileData) throw new Error('Could not read the signed PDF to append the audit page')

  const signedDoc = await PDFDocument.load(new Uint8Array(await signedFileData.arrayBuffer()))
  const pageCountBeforeAudit = signedDoc.getPageCount()

  const auditFont = await signedDoc.embedFont(StandardFonts.Helvetica)
  const auditBoldFont = await signedDoc.embedFont(StandardFonts.HelveticaBold)
  const auditPage = signedDoc.addPage([612, 792])
  const MARGIN_X = 48
  let auditCursorY = 740

  const drawAuditText = (
    x: number,
    text: string,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}
  ) => {
    auditPage.drawText(text, {
      x,
      y: auditCursorY,
      size: opts.size ?? 10,
      font: opts.bold ? auditBoldFont : auditFont,
      color: opts.color ?? rgb(0.13, 0.13, 0.15),
    })
  }
  const advance = (gap: number) => { auditCursorY -= gap }

  const now = new Date()
  const docId = (await sha256Hex(new TextEncoder().encode(`${session.id}:docid`))).slice(0, 32)
  const fileName = (template?.storage_path || '').split('/').pop() || 'onboarding-documents.pdf'

  // Header, styled like a title bar -- deliberately modeled on the Dropbox Sign audit
  // trail page (title + metadata block + "Document History" timeline) per direct
  // feedback that our own version should read the same way, not just carry the same
  // information as a dense text dump.
  drawAuditText(MARGIN_X, 'Audit trail', { size: 20, bold: true })
  drawAuditText(432, 'Talview', { size: 11, bold: true, color: rgb(0.42, 0.45, 0.5) })
  advance(30)
  auditPage.drawLine({
    start: { x: MARGIN_X, y: auditCursorY },
    end: { x: 564, y: auditCursorY },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.87),
  })
  advance(28)

  const metaRow = (label: string, value: string) => {
    drawAuditText(MARGIN_X, label, { size: 10, bold: true, color: rgb(0.35, 0.37, 0.4) })
    drawAuditText(210, value, { size: 10 })
    advance(22)
  }
  metaRow('Title', `${(template?.label || 'Onboarding Documents').split('(')[0].trim()} - ${formatIstDate(now)}`)
  metaRow('File name', fileName)
  metaRow('Document ID', docId)
  metaRow('Audit trail date format', 'DD Mon YYYY, HH:mm:ss IST')
  metaRow('Status', 'Completed')
  advance(14)
  auditPage.drawLine({
    start: { x: MARGIN_X, y: auditCursorY },
    end: { x: 564, y: auditCursorY },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.87),
  })
  advance(30)

  drawAuditText(MARGIN_X, 'Document History', { size: 13, bold: true })
  advance(30)

  const findEvent = (type: string) => (events || []).find((e) => e.event_type === type)
  const signerLine = `${session.signer_name_snapshot} (${session.signer_email_snapshot})`
  const historyRows: { label: string; when: Date; ip: string; description: string }[] = []

  const sentEvent = findEvent('link_emailed')
  if (sentEvent) {
    historyRows.push({
      label: 'SENT',
      when: new Date(sentEvent.occurred_at),
      ip: sentEvent.ip_address || 'unknown',
      description: `Sent for signature to ${signerLine}`,
    })
  }
  const viewedEvent = findEvent('nda_viewed')
  if (viewedEvent) {
    historyRows.push({
      label: 'VIEWED',
      when: new Date(viewedEvent.occurred_at),
      ip: viewedEvent.ip_address || 'unknown',
      description: `Viewed by ${signerLine}`,
    })
  }
  const signedEvent = findEvent('signed_pdf_generated')
  if (signedEvent) {
    historyRows.push({
      label: 'SIGNED',
      when: new Date(signedEvent.occurred_at),
      ip: signedEvent.ip_address || 'unknown',
      description: `Signed by ${signerLine}`,
    })
  }
  historyRows.push({
    label: 'COMPLETED',
    when: now,
    ip: '',
    description: 'The document has been completed.',
  })

  for (const row of historyRows) {
    auditPage.drawEllipse({
      x: MARGIN_X + 4,
      y: auditCursorY + 3,
      xScale: 4,
      yScale: 4,
      color: rgb(0.55, 0.68, 0.31),
    })
    drawAuditText(MARGIN_X + 16, row.label, { size: 9, bold: true, color: rgb(0.4, 0.43, 0.46) })
    drawAuditText(MARGIN_X + 100, formatIstDateTime(row.when), { size: 9, color: rgb(0.4, 0.43, 0.46) })
    advance(16)
    drawAuditText(MARGIN_X + 16, row.description, { size: 10 })
    advance(row.ip ? 14 : 30)
    if (row.ip) {
      drawAuditText(MARGIN_X + 16, `IP: ${row.ip}`, { size: 9, color: rgb(0.5, 0.52, 0.55) })
      advance(30)
    }
  }

  advance(10)
  auditPage.drawLine({
    start: { x: MARGIN_X, y: auditCursorY },
    end: { x: 564, y: auditCursorY },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.87),
  })
  advance(20)
  drawAuditText(MARGIN_X, 'A full, independently verifiable audit certificate (event-by-event log,', { size: 8, color: rgb(0.5, 0.52, 0.55) })
  advance(12)
  drawAuditText(MARGIN_X, 'document hashes, and a cryptographic evidence tag) is filed separately for this record.', { size: 8, color: rgb(0.5, 0.52, 0.55) })

  // Self-check against the in-memory doc, right after adding the page -- no need to
  // reload the saved bytes to know the page count (unlike the old version).
  const expectedPageCount = (template?.page_count ?? pageCountBeforeAudit) + 1
  if (signedDoc.getPageCount() !== expectedPageCount) {
    throw new Error('Appending the audit page produced an unexpected page count -- aborting')
  }

  const signedBytesWithAudit = await signedDoc.save()
  const signedPdfSha256WithAudit = await sha256Hex(signedBytesWithAudit)
  const { error: reuploadError } = await supabase.storage
    .from('nda-signing')
    .upload(session.signed_pdf_path, signedBytesWithAudit, { contentType: 'application/pdf', upsert: true })
  if (reuploadError) throw reuploadError

  const { error: sessionUpdateError } = await supabase
    .from('nda_signing_sessions')
    .update({
      certificate_path: certificatePath,
      certificate_sha256: certificateSha256,
      evidence_hmac: evidenceHmac,
      signed_pdf_sha256: signedPdfSha256WithAudit,
    })
    .eq('id', session.id)
  if (sessionUpdateError) throw sessionUpdateError

  await logEvent(supabase, session.id, 'submitted', req, { certificate_sha256: certificateSha256 })

  const docColumns: Record<string, string> = {}
  for (const d of docs || []) {
    docColumns[DOC_KIND_TO_COLUMN[d.doc_kind as keyof typeof DOC_KIND_TO_COLUMN]] = d.storage_path
  }

  const { error: proctorUpdateError } = await supabase
    .from('proctors')
    .update({ ...docColumns, final_form_status: 'submitted', upd: new Date().toISOString() })
    .eq('id', session.proctor_id)
  if (proctorUpdateError) throw proctorUpdateError

  return jsonResponse({ success: true })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const body = await req.json()

    if (body.action === 'sign') return await handleSign(supabase, req, body)
    if (body.action === 'finalize') return await handleFinalize(supabase, req, body)
    throw new Error('action must be "sign" or "finalize"')
  } catch (error) {
    return errorResponse(error)
  }
})
