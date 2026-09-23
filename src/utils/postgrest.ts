/**
 * Escapes a value for safe interpolation into a PostgREST `.or()`/`.and()` filter
 * string. PostgREST's filter-tree parser treats `,`, `.`, `(` and `)` as syntax, so
 * a raw value containing any of them (e.g. a search term, or a row's own name/email
 * used as a keyset-pagination cursor) breaks the filter with a PGRST100 parse error
 * instead of matching literally. Wrapping the value in double quotes disables that
 * parsing; a literal backslash or double quote inside must itself be backslash-escaped
 * so it can't be used to break back out of the quoting.
 */
export function escapePostgrestValue(value: string | number): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Builds a `.or()` filter string that ilike-searches `term` (wrapped in %...%)
 * across each of `columns`, with `term` safely escaped first. */
export function orIlikeFilter(columns: string[], term: string): string {
  const escaped = escapePostgrestValue(`%${term}%`);
  return columns.map((c) => `${c}.ilike.${escaped}`).join(',');
}
