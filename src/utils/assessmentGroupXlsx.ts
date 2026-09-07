// Generates and parses the coordinator-facing evaluation workbook for a Group
// Assessment session (see WorkspacePage's GroupScheduleCard): one row per candidate in
// the session, with dropdown-enabled Result/Remarks cells. XLSX (not CSV) specifically
// because CSV has no concept of per-cell data validation/dropdowns.
//
// exceljs is dynamically imported (not a top-level import) so its ~900KB isn't part of
// every page's bundle -- only whichever component actually opens a group schedule pays
// for it, and only once, on first use.
import { EVAL_REASON_OPTIONS_BY_RESULT } from './constants';

// The only values submit_evaluation_result's callers (the individual "Evaluate" modal,
// and now this bulk path) ever send -- there is no DB CHECK constraint on the column
// itself, this list is the actual source of truth the rest of the app already uses.
export const RESULT_OPTIONS = ['Pass', 'Reattempt', 'No Show', 'Reschedule'] as const;

// Excel's own Result-choice reason lists are keyed by result (Pass/Reattempt/etc, see
// EVAL_REASON_OPTIONS_BY_RESULT) -- a spreadsheet dropdown can't conditionally change
// its own option list based on another cell's value without INDIRECT()/named-range
// formulas, which is fragile to build and to verify outside a real Excel/Sheets
// session. Flattening every reason across every result into one list is a deliberate
// simplification: a coordinator sees more choices than are strictly relevant to
// whatever Result they picked, but every legitimate reason is always present.
const REMARKS_OPTIONS = Array.from(
  new Set([...Object.values(EVAL_REASON_OPTIONS_BY_RESULT).flat(), 'Other'])
);

const HEADER_ROW = 3;
const COLUMNS = [
  { header: 'Evaluation ID', key: 'evaluationId', width: 38 },
  { header: 'Proctor Name', key: 'proctorName', width: 24 },
  { header: 'Email', key: 'proctorEmail', width: 28 },
  { header: 'Vendor', key: 'vendor', width: 16 },
  { header: 'Type', key: 'ptype', width: 10 },
  { header: 'Attempt', key: 'attemptNumber', width: 9 },
  { header: 'Result', key: 'result', width: 14 },
  { header: 'Remarks', key: 'comment', width: 32 },
  { header: 'Score Obtained', key: 'scoreObtained', width: 14 },
  { header: 'Candidate ID', key: 'candidateId', width: 20 },
  { header: 'Section ID', key: 'sectionId', width: 20 },
] as const;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c.key, i + 1])) as Record<(typeof COLUMNS)[number]['key'], number>;

export interface GroupSessionInfo {
  panelUser: string;
  scheduledDate: string;
  scheduledTime: string | null;
  scoreOutOf: number | null;
}

export interface GroupEvaluationRow {
  evaluationId: string;
  proctorName: string;
  proctorEmail: string;
  vendor: string;
  ptype: string;
  attemptNumber: number;
  result: string | null;
  comment: string | null;
  scoreObtained: number | null;
  candidateId: string | null;
  sectionId: string | null;
}

export async function buildGroupEvaluationWorkbook(
  session: GroupSessionInfo,
  rows: GroupEvaluationRow[]
): Promise<Blob> {
  const buffer = await buildGroupEvaluationWorkbookBuffer(session, rows);
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** The actual workbook-building logic, returning the raw buffer rather than a Blob --
 * exported separately so it's testable without a real browser's Blob/File APIs
 * (jsdom's polyfills for both are too incomplete to round-trip through reliably). Real
 * app code should use buildGroupEvaluationWorkbook above. */
export async function buildGroupEvaluationWorkbookBuffer(
  session: GroupSessionInfo,
  rows: GroupEvaluationRow[]
): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();

  // Dropdown option lists live on their own hidden sheet, referenced by cell range
  // rather than an inline comma-separated list -- Excel caps an inline list-type
  // validation formula at 255 characters, which the flattened Remarks list can exceed.
  const listSheet = workbook.addWorksheet('Lists');
  RESULT_OPTIONS.forEach((v, i) => { listSheet.getCell(i + 1, 1).value = v; });
  REMARKS_OPTIONS.forEach((v, i) => { listSheet.getCell(i + 1, 2).value = v; });
  // 'veryHidden' (not just 'hidden') -- a plain hidden sheet can still be unhidden by
  // right-clicking any visible sheet tab in Excel; veryHidden can only be brought back
  // via VBA/the workbook XML, so it stays out of the coordinator's way for good.
  listSheet.state = 'veryHidden';

  const sheet = workbook.addWorksheet('Evaluation');
  COLUMNS.forEach((col, i) => { sheet.getColumn(i + 1).width = col.width; });

  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  const infoCell = sheet.getCell(1, 1);
  const parts = [`Panel: ${session.panelUser}`, `Date: ${session.scheduledDate}`];
  if (session.scheduledTime) parts.push(`Time: ${session.scheduledTime}`);
  if (session.scoreOutOf != null) parts.push(`Score Out Of: ${session.scoreOutOf}`);
  infoCell.value = `Group Assessment Session — ${parts.join(' · ')}`;
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
    r.getCell(COL.evaluationId).value = row.evaluationId;
    r.getCell(COL.proctorName).value = row.proctorName;
    r.getCell(COL.proctorEmail).value = row.proctorEmail;
    r.getCell(COL.vendor).value = row.vendor;
    r.getCell(COL.ptype).value = row.ptype;
    r.getCell(COL.attemptNumber).value = row.attemptNumber;
    r.getCell(COL.result).value = row.result || '';
    r.getCell(COL.comment).value = row.comment || '';
    r.getCell(COL.scoreObtained).value = row.scoreObtained ?? null;
    r.getCell(COL.candidateId).value = row.candidateId || '';
    r.getCell(COL.sectionId).value = row.sectionId || '';
  });

  const firstDataRow = HEADER_ROW + 1;
  const lastDataRow = HEADER_ROW + rows.length;
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    sheet.getCell(r, COL.result).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`Lists!$A$1:$A$${RESULT_OPTIONS.length}`],
      showErrorMessage: true,
      errorStyle: 'stop',
      error: `Must be one of: ${RESULT_OPTIONS.join(', ')}`,
    };
    sheet.getCell(r, COL.comment).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`Lists!$B$1:$B$${REMARKS_OPTIONS.length}`],
    };
  }

  // Evaluation ID is what upload-matching keys off of -- kept in the file (so a
  // coordinator can't lose the mapping by e.g. sorting the sheet) but hidden, since a
  // raw UUID means nothing to the person filling this in.
  sheet.getColumn(COL.evaluationId).hidden = true;

  // Lock every reference column (name/email/vendor/type/attempt) so a coordinator can't
  // accidentally overwrite the data upload-matching depends on -- only the columns they
  // actually need to fill in (Result, Remarks, Score, Candidate/Section ID) stay
  // editable. Sheet protection only takes effect once `protect()` is called below; a
  // blank password just means "guard against accidents", not "require a password" --
  // Excel's own Review > Unprotect Sheet works with no password, which is fine here.
  const EDITABLE_COLS = [COL.result, COL.comment, COL.scoreObtained, COL.candidateId, COL.sectionId];
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    COLUMNS.forEach((_, i) => {
      const colNum = i + 1;
      sheet.getCell(r, colNum).protection = { locked: !EDITABLE_COLS.includes(colNum) };
    });
  }
  await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  return workbook.xlsx.writeBuffer();
}

export interface ParsedGroupRow {
  evaluationId: string;
  result: string;
  comment: string;
  scoreObtained: number | null;
  candidateId: string;
  sectionId: string;
}

/** Reads back a workbook produced by buildGroupEvaluationWorkbook (or one a
 * coordinator saved/re-uploaded after editing it) -- locates the header row by its
 * "Evaluation ID" label rather than assuming a fixed row number, so it still works if
 * rows above it were nudged. */
export async function parseGroupEvaluationWorkbook(file: File): Promise<ParsedGroupRow[]> {
  return parseGroupEvaluationWorkbookBuffer(await file.arrayBuffer());
}

/** Same as parseGroupEvaluationWorkbook, taking the raw buffer directly -- exported
 * separately so it's testable without a real browser's File API (see
 * buildGroupEvaluationWorkbookBuffer for why). */
export async function parseGroupEvaluationWorkbookBuffer(buffer: ArrayBuffer): Promise<ParsedGroupRow[]> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.worksheets.find((ws) => ws.name !== 'Lists') || workbook.worksheets[0];
  if (!sheet) throw new Error('No worksheet found in the uploaded file');

  let headerRowNumber = -1;
  sheet.eachRow((row, rowNumber) => {
    if (headerRowNumber === -1 && String(row.getCell(COL.evaluationId).value ?? '').trim() === 'Evaluation ID') {
      headerRowNumber = rowNumber;
    }
  });
  if (headerRowNumber === -1) {
    throw new Error('Could not find the header row -- this doesn\'t look like a downloaded evaluation sheet');
  }

  const results: ParsedGroupRow[] = [];
  for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const evaluationId = String(row.getCell(COL.evaluationId).value ?? '').trim();
    if (!evaluationId) continue;
    const scoreRaw = row.getCell(COL.scoreObtained).value;
    results.push({
      evaluationId,
      result: String(row.getCell(COL.result).value ?? '').trim(),
      comment: String(row.getCell(COL.comment).value ?? '').trim(),
      scoreObtained: scoreRaw === null || scoreRaw === undefined || scoreRaw === '' ? null : Number(scoreRaw),
      candidateId: String(row.getCell(COL.candidateId).value ?? '').trim(),
      sectionId: String(row.getCell(COL.sectionId).value ?? '').trim(),
    });
  }
  return results;
}
