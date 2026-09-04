/**
 * components/data-table.tsx — Generic TanStack Table wrapper.
 * Renders a styled table from any ColumnDef + data array.
 *
 * @responsive Optional `mobileCard` render prop switches to a stacked card list
 * < md (768px); falls back to `overflow-x-auto` scroll when omitted. Pages
 * that want proper mobile UX pass `mobileCard`; simple pages stay backward-
 * compatible.
 */
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  onRowClick?: (row: T) => void;
  className?: string;
  /** When provided, renders a card list < md. Recommended for tables with 4+ cols. */
  mobileCard?: (row: T) => ReactNode;
  /** Extract stable key for mobile card list. Defaults to array index. */
  getRowId?: (row: T) => string;
  /** Empty state text. */
  emptyText?: string;
}

export function DataTable<T>({
  data,
  columns,
  onRowClick,
  className,
  mobileCard,
  getRowId,
  emptyText = 'Không có dữ liệu',
}: DataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const desktopTable = (
    <div className={cn('overflow-x-auto rounded-lg border border-gray-200', className)}>
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="bg-white divide-y divide-gray-100">
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-400">
                {emptyText}
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={cn(
                  'hover:bg-gray-50 transition-colors',
                  onRowClick && 'cursor-pointer',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 text-gray-700">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  // No mobileCard → old behavior (horizontal scroll everywhere).
  if (!mobileCard) return desktopTable;

  return (
    <>
      {/* Mobile: card list */}
      <div className="md:hidden space-y-2">
        {data.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400">
            {emptyText}
          </div>
        ) : (
          data.map((row, idx) => (
            <div
              key={getRowId ? getRowId(row) : idx}
              onClick={() => onRowClick?.(row)}
              className={cn(
                'rounded-lg border border-gray-200 bg-white p-3',
                onRowClick && 'cursor-pointer hover:bg-gray-50 transition-colors',
              )}
            >
              {mobileCard(row)}
            </div>
          ))
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block">{desktopTable}</div>
    </>
  );
}
