// Generates and parses the admin-facing bulk-certify workbook -- one row per proctor
// eligible for certification, with a Candidate ID and Section ID the admin fills in.
// Mirrors src/utils/assessmentGroupXlsx.ts's shape (locked reference columns, hidden id
// column for upload-matching, header row located by its label rather than a fixed row
// number) -- no dropdown validation needed here, both editable columns are free text,
// not an enumerated choice.
//
// exceljs is dynamically imported (not a top-level import), same reasoning as
// assessmentGroupXlsx.ts: only whichever admin actually opens Bulk Certify pays for it.

const HEADER_ROW = 2;
const COLUMNS = [
  { header: 'Proctor ID', key: 'proctorId', width: 38 },
  { header: 'PID', key: 'pid', width: 14 },
  { header: 'Proctor Name', key: 'proctorName', width: 24 },
  { header: 'Email', key: 'email', width: 28 },
  { header: 'Vendor', key: 'vendor', width: 16 },
  { header: 'Type', key: 'ptype', width: 10 },
  { header: 'Candidate ID', key: 'candidateId', width: 22 },
  { header: 'Section ID', key: 'sectionId', width: 22 },
] as const;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c.key, i + 1])) as Record<(typeof COLUMNS)[number]['key'], number>;

export interface CertificationCustomerInfo {
  id: string;
  name: string;
  currentVersion: number;
}

export interface CertificationRow {
  proctorId: string;
  pid: string;
  proctorName: string;
  email: string;
  vendor: string;
  ptype: string;
  candidateId: string | null;
  sectionId: string | null;
}

export async function buildCertificationWorkbook(
  customer: CertificationCustomerInfo,
  rows: CertificationRow[]
): Promise<Blob> {
  const buffer = await buildCertificationWorkbookBuffer(customer, rows);
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** The actual workbook-building logic, returning the raw buffer rather than a Blob --
 * exported separately so it's testable without a real browser's Blob/File APIs. Real
 * app code should use buildCertificationWorkbook above. */
export async function buildCertificationWorkbookBuffer(
  customer: CertificationCustomerInfo,
  rows: CertificationRow[]
): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Certify');
  COLUMNS.forEach((col, i) => { sheet.getColumn(i + 1).width = col.width; });

  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  const infoCell = sheet.getCell(1, 1);
  infoCell.value = `Bulk Certification — ${customer.name} (SOP v${customer.currentVersion})`;
  infoCell.font = { bold: true, size: 12 };
  sheet.getRow(1).height = 22;

  const headerRow = sheet.getRow(HEADER_ROW);
  COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });

  rows.forEach((row, i) => {
    const r = sheet.getRow(HEADER_ROW + 1 + i);
    r.getCell(COL.proctorId).value = row.proctorId;
    r.getCell(COL.pid).value = row.pid;
    r.getCell(COL.proctorName).value = row.proctorName;
    r.getCell(COL.email).value = row.email;
    r.getCell(COL.vendor).value = row.vendor;
    r.getCell(COL.ptype).value = row.ptype;
    r.getCell(COL.candidateId).value = row.candidateId || '';
    r.getCell(COL.sectionId).value = row.sectionId || '';
  });

  // Proctor ID is what upload-matching keys off of -- kept in the file (so an admin
  // can't lose the mapping by e.g. sorting the sheet) but hidden, since a raw UUID
  // means nothing to the person filling this in.
  sheet.getColumn(COL.proctorId).hidden = true;

  // Lock every reference column so an admin can't accidentally overwrite the data
  // upload-matching depends on -- only Candidate ID/Section ID stay editable.
  const firstDataRow = HEADER_ROW + 1;
  const lastDataRow = HEADER_ROW + rows.length;
  const EDITABLE_COLS = [COL.candidateId, COL.sectionId];
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    COLUMNS.forEach((_, i) => {
      const colNum = i + 1;
      sheet.getCell(r, colNum).protection = { locked: !EDITABLE_COLS.includes(colNum) };
    });
  }
  await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  // Which customer this file was generated for -- a completely separate, veryHidden
  // sheet (same technique assessmentGroupXlsx.ts uses for its "Lists" dropdown data),
  // read back at parse time and checked against whichever customer is currently
  // selected in the app before any upload is acted on. Without this, downloading a
  // template for customer A, then switching to customer B in the UI and uploading
  // that same file, would silently certify A's proctors against B -- this is what
  // makes that mistake impossible instead of just unlikely.
  const metaSheet = workbook.addWorksheet('Meta');
  metaSheet.getCell(1, 1).value = customer.id;
  metaSheet.state = 'veryHidden';

  return workbook.xlsx.writeBuffer();
}

export interface ParsedCertificationRow {
  proctorId: string;
  candidateId: string;
  sectionId: string;
}

export interface ParsedCertificationWorkbook {
  customerId: string | null;
  rows: ParsedCertificationRow[];
}

/** Reads back a workbook produced by buildCertificationWorkbook (or one an admin
 * saved/re-uploaded after editing it) -- locates the header row by its "Proctor ID"
 * label rather than assuming a fixed row number, so it still works if rows above it
 * were nudged. */
export async function parseCertificationWorkbook(file: File): Promise<ParsedCertificationWorkbook> {
  return parseCertificationWorkbookBuffer(await file.arrayBuffer());
}

/** Same as parseCertificationWorkbook, taking the raw buffer directly -- exported
 * separately so it's testable without a real browser's File API. */
export async function parseCertificationWorkbookBuffer(buffer: ArrayBuffer): Promise<ParsedCertificationWorkbook> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.worksheets.find((ws) => ws.name !== 'Meta') || workbook.worksheets[0];
  if (!sheet) throw new Error('No worksheet found in the uploaded file');

  const metaSheet = workbook.worksheets.find((ws) => ws.name === 'Meta');
  const customerId = metaSheet ? String(metaSheet.getCell(1, 1).value ?? '').trim() || null : null;

  let headerRowNumber = -1;
  sheet.eachRow((row, rowNumber) => {
    if (headerRowNumber === -1 && String(row.getCell(COL.proctorId).value ?? '').trim() === 'Proctor ID') {
      headerRowNumber = rowNumber;
    }
  });
  if (headerRowNumber === -1) {
    throw new Error('Could not find the header row -- this doesn\'t look like a downloaded certification sheet');
  }

  const rows: ParsedCertificationRow[] = [];
  for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const proctorId = String(row.getCell(COL.proctorId).value ?? '').trim();
    if (!proctorId) continue;
    rows.push({
      proctorId,
      candidateId: String(row.getCell(COL.candidateId).value ?? '').trim(),
      sectionId: String(row.getCell(COL.sectionId).value ?? '').trim(),
    });
  }
  return { customerId, rows };
}

export type CertificationRowStatus = 'to_certify' | 'blank' | 'incomplete' | 'not_eligible' | 'duplicate' | 'invalid_chars';

export interface EligibleProctorRef {
  id: string;
  pid: string;
  name: string;
}

export interface ClassifiedCertificationRow {
  proctorId: string;
  candidateId: string;
  sectionId: string;
  status: CertificationRowStatus;
  proctor?: EligibleProctorRef;
  reason?: string;
}

/** Sorts every parsed row into "will be certified" vs. a specific, visible reason it
 * won't be -- a blank row (the common case for a full eligible-list download) is the
 * one status that's genuinely a no-op, not a problem, so it's still tracked here but
 * meant to be hidden from the review table rather than flagged. Re-run this against a
 * freshly re-parsed file (or after an inline fix) to re-classify, rather than mutating
 * classified rows in place. */
export function classifyCertificationRows(
  parsedRows: ParsedCertificationRow[],
  currentlyEligible: EligibleProctorRef[]
): ClassifiedCertificationRow[] {
  const eligibleById = new Map(currentlyEligible.map((p) => [p.id, p]));
  const seenProctorIds = new Set<string>();
  const results: ClassifiedCertificationRow[] = [];

  // Walk in reverse so "the last occurrence of a duplicated proctor id wins" is a
  // simple first-seen-in-reverse check, then restore original row order at the end.
  for (let i = parsedRows.length - 1; i >= 0; i--) {
    const row = parsedRows[i];
    const candidateId = row.candidateId.trim();
    const sectionId = row.sectionId.trim();
    const base = { proctorId: row.proctorId, candidateId, sectionId };

    if (!candidateId && !sectionId) {
      results.unshift({ ...base, status: 'blank' });
      continue;
    }
    if (seenProctorIds.has(row.proctorId)) {
      results.unshift({ ...base, status: 'duplicate', reason: 'Duplicate row for this proctor -- only the last occurrence in the file is used.' });
      continue;
    }
    seenProctorIds.add(row.proctorId);

    if (!candidateId || !sectionId) {
      results.unshift({ ...base, status: 'incomplete', reason: 'Both Candidate ID and Section ID are required -- only one was filled in.' });
      continue;
    }
    if (candidateId.includes('/') || sectionId.includes('/')) {
      results.unshift({ ...base, status: 'invalid_chars', reason: "Candidate ID and Section ID can't contain '/'." });
      continue;
    }
    const proctor = eligibleById.get(row.proctorId);
    if (!proctor) {
      results.unshift({ ...base, status: 'not_eligible', reason: 'This proctor is no longer eligible -- already certified, deactivated, or not recognized.' });
      continue;
    }
    results.unshift({ ...base, status: 'to_certify', proctor });
  }

  return results;
}
