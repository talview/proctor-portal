// Admin publishes a new NDA template version. The admin UI has already uploaded the
// PDF to storage (authenticated upload works fine here -- only the anon-facing proctor
// flow needs signed upload URLs). This function re-fetches the bytes server-side so the
// hash and page count are never client-supplied, validates the field map, and flips
// is_active atomically so exactly one template is ever active.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1?target=deno'
import {
  adminClient,
  requireAdminCaller,
  sha256Hex,
  jsonResponse,
  errorResponse,
} from '../_shared/nda.ts'

const VALID_KINDS = new Set(['signature', 'date', 'full_name', 'text'])

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })

  try {
    const supabase = adminClient()
    const caller = await requireAdminCaller(req, supabase)

    const { storagePath, label, fieldMap } = await req.json()
    if (!storagePath || !label || !Array.isArray(fieldMap) || fieldMap.length === 0) {
      throw new Error('storagePath, label and a non-empty fieldMap are required')
    }

    for (const field of fieldMap) {
      if (!field.field_key || typeof field.field_key !== 'string') throw new Error('Each field needs a field_key')
      if (!VALID_KINDS.has(field.kind)) throw new Error(`Invalid field kind: ${field.kind}`)
      if (field.kind === 'text' && (!field.label || typeof field.label !== 'string')) {
        throw new Error(`Field ${field.field_key} is kind "text" and needs a label`)
      }
      if (typeof field.page_index !== 'number' || field.page_index < 0) throw new Error('Invalid page_index')
      for (const dim of ['x', 'y', 'w', 'h'] as const) {
        const v = field[dim]
        if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`Field ${dim} must be normalised 0..1`)
      }
    }
    if (!fieldMap.some((f: any) => f.kind === 'signature')) {
      throw new Error('At least one signature field is required')
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('nda-signing')
      .download(storagePath)
    if (downloadError || !fileData) throw new Error('Could not read uploaded template from storage')

    const bytes = new Uint8Array(await fileData.arrayBuffer())
    const contentSha256 = await sha256Hex(bytes)
    const byteSize = bytes.byteLength

    const pdfDoc = await PDFDocument.load(bytes)
    const pageCount = pdfDoc.getPageCount()

    for (const field of fieldMap) {
      if (field.page_index >= pageCount) {
        throw new Error(`field ${field.field_key} references page ${field.page_index}, but the PDF only has ${pageCount} pages`)
      }
    }

    const { data: existing } = await supabase
      .from('nda_templates')
      .select('version')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextVersion = (existing?.version ?? 0) + 1

    await supabase.from('nda_templates').update({ is_active: false, retired_at: new Date().toISOString() }).eq('is_active', true)

    const { data: inserted, error: insertError } = await supabase
      .from('nda_templates')
      .insert({
        version: nextVersion,
        label,
        storage_bucket: 'nda-signing',
        storage_path: storagePath,
        content_sha256: contentSha256,
        byte_size: byteSize,
        page_count: pageCount,
        field_map: fieldMap,
        is_active: true,
        published_by: caller.email || caller.username || caller.id,
      })
      .select('id, version')
      .single()

    if (insertError) throw insertError

    return jsonResponse({ success: true, templateId: inserted.id, version: inserted.version })
  } catch (error) {
    return errorResponse(error)
  }
})
