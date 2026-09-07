/** Triggers a browser download of an already-built Blob (e.g. an XLSX workbook) --
 * the same createObjectURL/anchor-click/revoke mechanic src/lib/csv.ts's downloadCsv
 * uses, factored out since it isn't CSV-specific. */
export function downloadBlob(filename: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
