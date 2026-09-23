// The two heavy PDF passes in the NDA-signing flow, moved out of nda-session-submit
// so both the candidate-facing edge function (fast path: just queues a job) and
// nda-jobs-worker (the actual work) can share one implementation. Neither function
// here does any job-table bookkeeping (status/attempt_count/locking) -- that's the
// worker's responsibility; these just do the PDF work itself and throw on failure,
// exactly like the synchronous code they're extracted from used to.
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1?target=deno'
import {
  adminClient,
  sha256Hex,
  hmacHex,
  fieldRectToPdfSpace,
  formatIstDate,
  formatIstDateTime,
  logEvent,
  DOC_KIND_TO_COLUMN,
} from './nda.ts'

/**
 * Downloads the template once, draws every field + the Doc ID footer, uploads the
 * result, and marks the session "signed". Unchanged from the original synchronous
 * version except it no longer catches its own errors into `render_error` -- the
 * worker does that now, since it also needs to know whether to retry or go terminal.
 */
export async function renderSignedPdf(
  supabase: ReturnType<typeof adminClient>,
  session: any,
  template: any,
  signatureBytes: Uint8Array,
  textValues: Record<string, string>,
  signerIp: string | null = null,
  signerUserAgent: string | null = null
) {
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
  // independent of the evidence HMAC computed later.
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

  await logEvent(supabase, session.id, 'signed_pdf_generated', { ip: signerIp, userAgent: signerUserAgent }, { sha256: signedPdfSha256 })

  const { error: sessionUpdateError } = await supabase
    .from('nda_signing_sessions')
    .update({ status: 'signed', signed_pdf_path: signedPdfPath, signed_pdf_sha256: signedPdfSha256 })
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
}

/**
 * Builds the audit certificate, appends the one-page audit summary to the already-
 * signed PDF, and marks the session completed. Unchanged in substance from the
 * original handleFinalize's back half, with one deliberate fix: the session is only
 * flipped to 'completed' at the very end, after every storage/DB write here has
 * already succeeded -- the original synchronous version flipped it to 'completed'
 * *before* building the certificate, which was harmless when this all happened in one
 * uninterruptible request, but would be a real gap now that this work is resumable:
 * a job that fails partway through certificate-building must not leave the session
 * already reading 'completed'.
 */
export async function buildAndAttachCertificate(supabase: ReturnType<typeof adminClient>, session: any) {
  const { data: docs } = await supabase
    .from('nda_session_documents')
    .select('doc_kind, storage_path, content_sha256, byte_size, integrity_status')
    .eq('session_id', session.id)

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
  // sees when they just open the document they signed.
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

  // req is null here (unlike the original synchronous version, which had the
  // candidate's actual Finalize request to pull IP/user-agent from) -- this now runs
  // decoupled from any single request, in the worker, which is the whole point of
  // making it durable. logEvent already treats req:null as the background-job case.
  await logEvent(supabase, session.id, 'submitted', null, { certificate_sha256: certificateSha256 })

  const docColumns: Record<string, string> = {}
  for (const d of docs || []) {
    docColumns[DOC_KIND_TO_COLUMN[d.doc_kind as keyof typeof DOC_KIND_TO_COLUMN]] = d.storage_path
  }

  const { error: proctorUpdateError } = await supabase
    .from('proctors')
    .update({ ...docColumns, final_form_status: 'submitted', upd: new Date().toISOString() })
    .eq('id', session.proctor_id)
  if (proctorUpdateError) throw proctorUpdateError

  // Only now, after every write above has succeeded, is the session actually
  // "completed" -- deliberately later than the original synchronous version, so a
  // job that fails partway through this function never leaves the session reading
  // 'completed' while the certificate/audit page is genuinely missing or stale.
  const { error: finalStatusError } = await supabase
    .from('nda_signing_sessions')
    .update({ status: 'completed' })
    .eq('id', session.id)
    .eq('status', 'signed')
  if (finalStatusError) throw finalStatusError
}
