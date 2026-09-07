/**
 * Shared CSV download helper -- consolidates what used to be three near-identical
 * implementations (EvaluationsPage, CertificationsPage, OffboardedPage), each with
 * a slightly different escaping/BOM inconsistency. Conditional quoting (RFC 4180 --
 * only quote when a value actually contains a comma/quote/newline) and a UTF-8 BOM
 * (so Excel doesn't mangle non-ASCII names) are applied uniformly here.
 */
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
