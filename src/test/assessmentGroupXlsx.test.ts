import { describe, it, expect } from 'vitest';
import {
  buildGroupEvaluationWorkbookBuffer,
  parseGroupEvaluationWorkbookBuffer,
  RESULT_OPTIONS,
} from '@/utils/assessmentGroupXlsx';

describe('assessmentGroupXlsx', () => {
  const session = { panelUser: 'coordinator1', scheduledDate: '2026-09-10', scheduledTime: '10:00', scoreOutOf: 100 };
  const rows = [
    {
      evaluationId: '11111111-1111-1111-1111-111111111111',
      proctorName: 'Alice Test',
      proctorEmail: 'alice@example.com',
      vendor: 'Sai',
      ptype: 'WFO',
      attemptNumber: 1,
      result: null,
      comment: null,
      scoreObtained: null,
      candidateId: null,
      sectionId: null,
    },
    {
      evaluationId: '22222222-2222-2222-2222-222222222222',
      proctorName: 'Bob Test',
      proctorEmail: 'bob@example.com',
      vendor: 'TSN',
      ptype: 'ODP',
      attemptNumber: 2,
      result: 'Reattempt',
      comment: 'Needs more preparation',
      scoreObtained: 40,
      candidateId: null,
      sectionId: null,
    },
  ];

  it('round-trips an unedited workbook back to the same rows', async () => {
    const buffer = await buildGroupEvaluationWorkbookBuffer(session, rows);
    expect(buffer.byteLength).toBeGreaterThan(0);
    const parsed = await parseGroupEvaluationWorkbookBuffer(buffer);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      evaluationId: rows[0].evaluationId,
      result: '',
      comment: '',
      scoreObtained: null,
    });
    expect(parsed[1]).toMatchObject({
      evaluationId: rows[1].evaluationId,
      result: 'Reattempt',
      comment: 'Needs more preparation',
      scoreObtained: 40,
    });
  });

  it('reflects edits made directly to the generated workbook (simulating a filled-in sheet)', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const buffer = await buildGroupEvaluationWorkbookBuffer(session, rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Evaluation')!;

    // Header banner (row1) + blank (row2) + header row (row3) -> data starts row4.
    const firstDataRow = 4;
    sheet.getRow(firstDataRow).getCell(7).value = 'Pass'; // Result
    sheet.getRow(firstDataRow).getCell(8).value = 'Strong overall performance'; // Remarks
    sheet.getRow(firstDataRow).getCell(9).value = 92; // Score Obtained
    sheet.getRow(firstDataRow).getCell(10).value = 'CAND-001'; // Candidate ID
    sheet.getRow(firstDataRow).getCell(11).value = 'SECT-001'; // Section ID

    const editedBuffer = await workbook.xlsx.writeBuffer();
    const parsed = await parseGroupEvaluationWorkbookBuffer(editedBuffer as unknown as ArrayBuffer);
    expect(parsed[0]).toMatchObject({
      evaluationId: rows[0].evaluationId,
      result: 'Pass',
      comment: 'Strong overall performance',
      scoreObtained: 92,
      candidateId: 'CAND-001',
      sectionId: 'SECT-001',
    });
  });

  it('every RESULT_OPTIONS value is accepted by the Result dropdown list written to the Lists sheet', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const buffer = await buildGroupEvaluationWorkbookBuffer(session, rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const listSheet = workbook.getWorksheet('Lists')!;
    const values = RESULT_OPTIONS.map((_, i) => listSheet.getCell(i + 1, 1).value);
    expect(values).toEqual([...RESULT_OPTIONS]);
  });

  it('hides the Lists sheet as veryHidden, not just hidden', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const buffer = await buildGroupEvaluationWorkbookBuffer(session, rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.getWorksheet('Lists')!.state).toBe('veryHidden');
  });

  it('locks reference columns and leaves only the coordinator-editable ones unlocked', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const buffer = await buildGroupEvaluationWorkbookBuffer(session, rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Evaluation')!;
    const firstDataRow = 4;
    const editable = [7, 8, 9, 10, 11]; // Result, Remarks, Score Obtained, Candidate ID, Section ID
    const locked = [1, 2, 3, 4, 5, 6]; // Evaluation ID, Proctor Name, Email, Vendor, Type, Attempt
    editable.forEach((col) => {
      expect(sheet.getRow(firstDataRow).getCell(col).protection?.locked).toBe(false);
    });
    locked.forEach((col) => {
      // Locked is the default for a cell, and OOXML omits the attribute entirely rather
      // than writing it out explicitly -- so after a write/read round-trip an
      // (intentionally) locked cell reads back as `undefined`, not `true`. Only
      // `false` (explicitly written for the editable columns above) is meaningful here.
      expect(sheet.getRow(firstDataRow).getCell(col).protection?.locked).not.toBe(false);
    });
  });

  it('throws a clear error when the uploaded file has no recognizable header row', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Nonsense').getCell(1, 1).value = 'not an evaluation sheet';
    const buffer = await workbook.xlsx.writeBuffer();
    await expect(parseGroupEvaluationWorkbookBuffer(buffer as unknown as ArrayBuffer)).rejects.toThrow(
      /header row/i
    );
  });
});
