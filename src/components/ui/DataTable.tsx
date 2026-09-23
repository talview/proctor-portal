import { Fragment, ReactNode } from 'react';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Inbox, ArrowUp, ArrowDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import EmptyState from './EmptyState';
import LoadingSpinner from './LoadingSpinner';

interface CursorPagination {
  pageIndex: number;
  pageSize: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isFetching?: boolean;
  onNext: () => void;
  onPrevious: () => void;
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  isLoading?: boolean;
  emptyMessage?: string;
  rowClassName?: (row: T) => string;
  onRowClick?: (row: T) => void;
  renderExpandedRow?: (row: T, index: number) => ReactNode;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** Cursor/keyset pagination -- Next/Previous only, no page-jump and no "of N
   * total" (getting an exact count back is exactly the cost this was written to
   * avoid). See useCursorPaginatedQuery. */
  pagination?: CursorPagination;
}

/** TanStack Table's headless core drives sorting/row-model state; every actual
 * DOM element (table/thead/tbody/pagination footer) is still hand-rendered here
 * with this app's own styling, matching what the old Table component looked
 * like -- adopting TanStack Table changed the state/columns model underneath,
 * not the visual language on top of it. */
export default function DataTable<T extends Record<string, any>>({
  data,
  columns,
  isLoading = false,
  emptyMessage = 'No data available',
  rowClassName,
  onRowClick,
  renderExpandedRow,
  sorting,
  onSortingChange,
  pagination,
}: DataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    state: sorting ? { sorting } : undefined,
    onSortingChange: onSortingChange
      ? (updater) => {
          const next = typeof updater === 'function' ? updater(sorting ?? []) : updater;
          onSortingChange(next);
        }
      : undefined,
    manualSorting: false,
    // Safety net for cursor-paginated tables (`pagination` set): client-side
    // sorting only ever sorts the current page's rows, silently misleading
    // the user into thinking they're seeing e.g. the alphabetically-first
    // record overall. Only a table that's also wired up its own server-driven
    // sort (`onSortingChange`) opts back in -- every column's own
    // `enableSorting` is overridden either way, so a column can't reintroduce
    // this by accident.
    enableSorting: pagination ? Boolean(onSortingChange) : true,
  });

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

  const rows = table.getRowModel().rows;

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto max-h-[78vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="bg-surface2 sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  const meta = header.column.columnDef.meta as { className?: string; headerClassName?: string } | undefined;
                  return (
                    <th
                      key={header.id}
                      onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
                      className={`
                        px-3.5 py-2 text-left text-[11px] font-semibold
                        text-text3 uppercase tracking-wide border-b border-border
                        whitespace-nowrap bg-surface2
                        ${sortable ? 'cursor-pointer select-none hover:text-text2' : ''}
                        ${meta?.headerClassName ?? meta?.className ?? ''}
                      `}
                    >
                      {header.isPlaceholder ? null : (
                        <span className="inline-flex items-center gap-1">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortable && (
                            sortDir ? (
                              sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                            ) : (
                              <ChevronsUpDown className="w-3 h-3 opacity-40" />
                            )
                          )}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState icon={Inbox} title={emptyMessage} compact />
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <Fragment key={row.id}>
                  <tr
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={`hover:bg-surface2 dark:hover:bg-white/5 transition-colors ${onRowClick ? 'cursor-pointer' : ''} ${rowClassName?.(row.original) || ''}`}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta as { className?: string } | undefined;
                      return (
                        <td
                          key={cell.id}
                          className={`
                            px-3.5 py-2 border-b border-border text-[13px] text-text2
                            ${rowIndex === rows.length - 1 ? 'border-b-0' : ''}
                            ${meta?.className || ''}
                          `}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                  {renderExpandedRow?.(row.original, rowIndex)}
                </Fragment>
              ))
            )}
          </tbody>
          {pagination && (
            <tfoot className="sticky bottom-0 z-10">
              <CursorPaginationRow columns={columns.length} {...pagination} rowCount={rows.length} />
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function CursorPaginationRow({
  columns,
  pageIndex,
  pageSize,
  rowCount,
  hasNextPage,
  hasPreviousPage,
  isFetching,
  onNext,
  onPrevious,
}: CursorPagination & { columns: number; rowCount: number }) {
  const from = rowCount === 0 ? 0 : pageIndex * pageSize + 1;
  const to = pageIndex * pageSize + rowCount;

  return (
    <tr>
      <td colSpan={columns} className="p-0 border-t border-border bg-surface2">
        <div className="flex items-center justify-between px-3.5 py-2 text-[11px] text-text2">
          <span>{rowCount === 0 ? 'No results' : `Showing ${from}–${to}`}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={!hasPreviousPage}
              onClick={onPrevious}
              className="p-1 rounded border border-border text-text2 hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <button
              type="button"
              aria-label="Next page"
              disabled={!hasNextPage || isFetching}
              onClick={onNext}
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
