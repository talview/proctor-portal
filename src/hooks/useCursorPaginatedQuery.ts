import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import { escapePostgrestValue, orIlikeFilter } from '@/utils/postgrest';

interface UseCursorPaginatedQueryOptions {
  /** Base query key -- page/searchTerm are appended automatically. */
  queryKey: unknown[];
  table: string;
  select?: string;
  /** Apply .eq()/.in()/etc to the query builder before search/order/cursor. */
  filters?: (q: any) => any;
  /** Columns to substring-search (OR'd together via ilike) when searchTerm is set. */
  searchColumns?: string[];
  searchTerm?: string;
  pageSize: number;
  /** Also doubles as the cursor's sort key -- `id` is always appended as a
   * tiebreaker, so ties on this column still produce a stable total order. */
  orderBy: { column: string; ascending?: boolean };
  enabled?: boolean;
  /** Bump this (e.g. a counter, or a JSON string of active filters) whenever a
   * filter/search change should snap back to the first page -- cursors from
   * before the change don't mean anything against the new result set. */
  resetKey?: unknown;
  /** The tiebreaker column appended after orderBy.column -- must be unique per
   * row. Defaults to 'id'; pass the real key for a view/table that doesn't have
   * a plain 'id' (e.g. certification_registry, keyed by 'pid'). */
  idColumn?: string;
}

/**
 * Keyset ("cursor") pagination instead of `.range()` offset pagination: fetches
 * pageSize+1 rows past the last-seen row's sort key so "is there a next page"
 * comes for free from the same query, with no separate count() at all --
 * correct and equally fast at page 1 or page 100,000, which OFFSET is not.
 * The real trade-off is real too, not hidden: this only supports Next/Previous,
 * not jumping to an arbitrary page number, and there's no "of N total" figure
 * to show, because getting one back would mean paying for the exact count this
 * was written to avoid.
 */
export function useCursorPaginatedQuery<T>({
  queryKey,
  table,
  select = '*',
  filters,
  searchColumns,
  searchTerm,
  pageSize,
  orderBy,
  enabled = true,
  resetKey,
  idColumn = 'id',
}: UseCursorPaginatedQueryOptions) {
  const trimmedSearch = searchTerm?.trim() || '';
  const ascending = orderBy.ascending ?? true;

  // pageIndex is 0-based; cursors[i] is the sort-key of the last row on page i-1
  // (the row to page *after*), so cursors[0] is always null (no cursor -> first
  // page) and cursors[pageIndex] is what the current fetch uses.
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<Array<{ sortVal: unknown; id: string } | null>>([null]);

  useEffect(() => {
    setPageIndex(0);
    setCursors([null]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, trimmedSearch]);

  const cursor = cursors[pageIndex] ?? null;

  const query = useQuery({
    queryKey: [...queryKey, 'cursor', pageIndex, trimmedSearch],
    queryFn: async () => {
      let q = supabase.from(table).select(select);
      if (filters) q = filters(q);
      if (trimmedSearch && searchColumns && searchColumns.length > 0) {
        q = q.or(orIlikeFilter(searchColumns, trimmedSearch));
      }
      if (cursor) {
        const op = ascending ? 'gt' : 'lt';
        const sortVal = cursor.sortVal instanceof Date ? cursor.sortVal.toISOString() : cursor.sortVal;
        const sortValEsc = escapePostgrestValue(sortVal as string | number);
        const idEsc = escapePostgrestValue(cursor.id);
        q = q.or(`${orderBy.column}.${op}.${sortValEsc},and(${orderBy.column}.eq.${sortValEsc},${idColumn}.${op}.${idEsc})`);
      }
      q = q
        .order(orderBy.column, { ascending })
        .order(idColumn, { ascending })
        // One extra row past pageSize -- its presence alone answers "is there a
        // next page", so this never needs a count() to know when to stop.
        .limit(pageSize + 1);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []) as T[];
      return {
        rows: rows.slice(0, pageSize) as T[],
        hasNextPage: rows.length > pageSize,
      };
    },
    placeholderData: keepPreviousData,
    enabled,
  });

  const rows = query.data?.rows ?? [];

  const goToNextPage = () => {
    if (!query.data?.hasNextPage || rows.length === 0) return;
    const last = rows[rows.length - 1] as any;
    const nextCursor = { sortVal: last[orderBy.column], id: last[idColumn] };
    setCursors((prev) => {
      const next = prev.slice(0, pageIndex + 1);
      next[pageIndex + 1] = nextCursor;
      return next;
    });
    setPageIndex((p) => p + 1);
  };

  const goToPreviousPage = () => setPageIndex((p) => Math.max(0, p - 1));

  return {
    data: rows,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    hasNextPage: query.data?.hasNextPage ?? false,
    hasPreviousPage: pageIndex > 0,
    goToNextPage,
    goToPreviousPage,
    /** Display-only (e.g. "showing X-Y") -- pagination itself is cursor-driven,
     * not index-driven. */
    pageIndex,
  };
}
