import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';

interface UsePaginatedQueryOptions {
  /** Base query key -- page/pageSize/searchTerm are appended automatically so each
   * page/search combination gets its own cache entry. */
  queryKey: unknown[];
  table: string;
  select?: string;
  /** Apply .eq()/.in()/etc to the query builder before search/order/range. */
  filters?: (q: any) => any;
  /** Columns to substring-search (OR'd together via ilike) when searchTerm is set. */
  searchColumns?: string[];
  searchTerm?: string;
  /** 1-indexed page number. */
  page: number;
  pageSize: number;
  orderBy?: { column: string; ascending?: boolean };
  enabled?: boolean;
  /** 'exact' (default) always returns a true total, at the cost of a full count on
   * every request -- fine while a table is small, but that cost grows with the
   * table regardless of page size. 'estimated' asks PostgREST to fall back to the
   * query planner's row estimate once the matching set is large (it still counts
   * exactly under PostgREST's own max-rows threshold), trading exact totals on
   * very large result sets for a bounded, cheap count. Use on tables expected to
   * grow the most (evaluations, audit log); leave the rest on 'exact'. */
  countMode?: 'exact' | 'estimated';
}

/**
 * Wraps a Supabase `.range()` + `{count:'exact'}` query in react-query, with
 * `placeholderData: keepPreviousData` so paging doesn't flash a loading state.
 * Search moves server-side via `.ilike()` rather than fetching everything and
 * filtering in the browser.
 */
export function usePaginatedQuery<T>({
  queryKey,
  table,
  select = '*',
  filters,
  searchColumns,
  searchTerm,
  page,
  pageSize,
  orderBy,
  enabled = true,
  countMode = 'exact',
}: UsePaginatedQueryOptions) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const trimmedSearch = searchTerm?.trim() || '';

  return useQuery({
    queryKey: [...queryKey, { page, pageSize, search: trimmedSearch }],
    queryFn: async () => {
      const buildQuery = (rangeFrom: number, rangeTo: number) => {
        let q = supabase.from(table).select(select, { count: countMode });
        if (filters) q = filters(q);
        if (trimmedSearch && searchColumns && searchColumns.length > 0) {
          q = q.or(searchColumns.map((c) => `${c}.ilike.%${trimmedSearch}%`).join(','));
        }
        if (orderBy) q = q.order(orderBy.column, { ascending: orderBy.ascending ?? true });
        return q.range(rangeFrom, rangeTo);
      };

      let { data, error, count } = await buildQuery(from, to);
      // A page/filter change can briefly pair a stale page number with a new,
      // smaller result set (e.g. a page-reset effect committing one render
      // after the filter itself) -- PostgREST answers an out-of-bounds .range()
      // with a hard error rather than an empty page. Rather than surface that
      // as a fetch error, fall back to page 1 once; the caller's own page state
      // corrects on its next render regardless.
      if (error && from > 0) {
        ({ data, error, count } = await buildQuery(0, pageSize - 1));
      }
      if (error) throw error;
      return { data: (data || []) as T[], count: count || 0 };
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}
