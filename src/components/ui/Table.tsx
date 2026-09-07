import { Fragment, ReactNode, useMemo, useState } from 'react';
import { Inbox, ArrowUp, ArrowDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import EmptyState from './EmptyState';
import LoadingSpinner from './LoadingSpinner';

interface Column<T> {
  header: ReactNode;
  accessor: keyof T | ((row: T, index: number) => ReactNode);
  /** Applied to both <th> and <td> (e.g. whitespace-nowrap on a header). */
  className?: string;
  /** Overrides className on the <th> only -- for a column whose cell styling
   * (e.g. text-right font-mono text-danger for a numeric column) shouldn't
   * also apply to the header text. Falls back to `className` if omitted. */
  headerClassName?: string;
  /** Opt-in: provide a comparable value per row to make this column clickable-to-sort. */
  sortValue?: (row: T) => string | number;
}

interface TableProps<T> {
  data: T[];
  columns: Column<T>[];
  isLoading?: boolean;
  emptyMessage?: string;
  /** Opt-in: extra classes for a specific row (e.g. a red tint on an invalid
   * bulk-import row), added alongside the default hover style. */
  rowClassName?: (row: T) => string;
  /** Opt-in: makes rows clickable (e.g. select-a-proctor lists) -- adds a
   * pointer cursor and calls back with the row. */
  onRowClick?: (row: T) => void;
  /** Opt-in: extra <tr>s rendered directly below a given row (e.g. an
   * expandable attempt-history sub-table). Return null for no extra rows. */
  renderExpandedRow?: (row: T, index: number) => ReactNode;
  /** Opt-in: renders a compact page-nav footer row, stuck to the bottom of
   * this table's own scroll area (same technique as the sticky header, just
   * the other end) -- so it's always visible without scrolling the page,
   * joined to the table instead of a separate card underneath it. */
  pagination?: {
    page: number;
    pageSize: number;
    count: number;
    isFetching?: boolean;
    onPageChange: (page: number) => void;
  };
}

export default function Table<T extends Record<string, any>>({
  data,
  columns,
  isLoading = false,
  emptyMessage = 'No data available',
  rowClassName,
  onRowClick,
  renderExpandedRow,
  pagination,
}: TableProps<T>) {
  const [sort, setSort] = useState<{ index: number; dir: 'asc' | 'desc' } | null>(null);

  const getCellValue = (row: T, column: Column<T>, index: number): ReactNode => {
    if (typeof column.accessor === 'function') {
      return column.accessor(row, index);
    }
    return row[column.accessor];
  };

  const sortedData = useMemo(() => {
    if (!sort) return data;
    const column = columns[sort.index];
    if (!column?.sortValue) return data;
    const copy = [...data];
    copy.sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sort]);

  const toggleSort = (index: number) => {
    setSort((prev) => {
      if (!prev || prev.index !== index) return { index, dir: 'asc' };
      if (prev.dir === 'asc') return { index, dir: 'desc' };
      return null;
    });
  };

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="flex items-center justify-center py-16">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner size="md" />
            <p className="text-text2 text-sm">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="bg-surface2 sticky top-0 z-10">
            <tr>
              {columns.map((column, index) => {
                const sortable = !!column.sortValue;
                const isActive = sort?.index === index;
                return (
                  <th
                    key={index}
                    onClick={sortable ? () => toggleSort(index) : undefined}
                    className={`
                      px-3.5 py-2.5 text-left text-[11px] font-semibold
                      text-text3 uppercase tracking-wide border-b border-border
                      whitespace-nowrap bg-surface2
                      ${sortable ? 'cursor-pointer select-none hover:text-text2' : ''}
                      ${column.headerClassName ?? column.className ?? ''}
                    `}
                  >
                    <span className="inline-flex items-center gap-1">
                      {column.header}
                      {sortable && (
                        isActive ? (
                          sort!.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 opacity-40" />
                        )
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState icon={Inbox} title={emptyMessage} compact />
                </td>
              </tr>
            ) : (
              sortedData.map((row, rowIndex) => (
                <Fragment key={rowIndex}>
                  <tr
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`hover:bg-white/[0.02] transition-colors ${onRowClick ? 'cursor-pointer' : ''} ${rowClassName?.(row) || ''}`}
                  >
                    {columns.map((column, colIndex) => (
                      <td
                        key={colIndex}
                        className={`
                          px-3.5 py-3 border-b border-border text-[13px] text-text2
                          ${rowIndex === sortedData.length - 1 ? 'border-b-0' : ''}
                          ${column.className || ''}
                        `}
                      >
                        {getCellValue(row, column, rowIndex)}
                      </td>
                    ))}
                  </tr>
                  {renderExpandedRow?.(row, rowIndex)}
                </Fragment>
              ))
            )}
          </tbody>
          {pagination && (
            <tfoot className="sticky bottom-0 z-10">
              <PaginationRow columns={columns.length} {...pagination} />
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function PaginationRow({
  columns,
  page,
  pageSize,
  count,
  isFetching,
  onPageChange,
}: {
  columns: number;
  page: number;
  pageSize: number;
  count: number;
  isFetching?: boolean;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const from = count === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, count);

  return (
    <tr>
      <td colSpan={columns} className="p-0 border-t border-border bg-surface2">
        <div className="flex items-center justify-between px-3.5 py-2 text-[11px] text-text2">
          <span>{count === 0 ? 'No results' : `${from}–${to} of ${count}`}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className="p-1 rounded border border-border text-text2 hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <span className="font-semibold text-text px-1">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={page >= totalPages || isFetching}
              onClick={() => onPageChange(page + 1)}
              className="p-1 rounded border border-border text-text2 hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}
