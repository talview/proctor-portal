/**
 * Shared CSV download helper -- consolidates what used to be three near-identical
 * implementations (EvaluationsPage, CertificationsPage, OffboardedPage), each with
 * a slightly different escaping/BOM inconsistency. Conditional quoting (RFC 4180 --
 * only quote when a value actually contains a comma/quote/newline) and a UTF-8 BOM
 * (so Excel doesn't mangle non-ASCII names) are applied uniformly here.
 */
/**
 * Parses raw CSV text into rows of trimmed string values -- a real character-by-
 * character state machine (quoted fields, embedded commas, escaped "" quotes), not
 * a per-line regex tokenizer. The regex previously used by a couple of upload flows
 * (`/(".*?"|[^,]+)(?=\s*,|\s*$)/g`) silently drops empty fields instead of
 * preserving their position, shifting every later column left by one whenever a
 * row had a blank cell before its last column. Blank lines are skipped entirely.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur = '';
  let inQuotes = false;
  let row: string[] = [];
  const chars = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '"') {
      if (inQuotes && chars[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(cur.trim());
      cur = '';
    } else if (c === '\n' && !inQuotes) {
      row.push(cur.trim());
      cur = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  if (cur || row.length) row.push(cur.trim());
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

/** Hard ceiling on rows a single "export everything matching these filters"
 * click will fetch. These exports run as one unpaginated query against
 * whatever's currently filtered on screen -- fine at this app's current data
 * volume, but pulling an unbounded result set into the browser tab stops
 * being fine as that volume grows. Callers should fetch `.range(0,
 * EXPORT_ROW_CAP)` (one row past the cap, so a truncated result can be
 * detected), slice back to EXPORT_ROW_CAP rows, and warn the admin when the
 * result was cut off so they know to narrow their filters rather than assume
 * they got a complete export. */
export const EXPORT_ROW_CAP = 10_000;

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (value: unknown) => {
    const s = String(value ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const BOM = '\uFEFF';
  const csv = BOM + [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
