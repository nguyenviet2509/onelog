/**
 * components/pagination.tsx — Client-side pagination bar.
 *
 * @responsive Stack vertical < sm (page-size selector + info trên, nút Prev/Next
 * dưới). Row inline ≥ sm. Nút compact `p-2` cho touch target ≥ 40px.
 */
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange?: (n: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

const DEFAULT_SIZES = [10, 20, 50, 100];

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_SIZES,
  className,
}: PaginationProps) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div
      className={cn(
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm',
        className,
      )}
    >
      <div className="flex items-center gap-3 text-gray-600 flex-wrap">
        <span>
          {total === 0 ? '0 dòng' : `${from}–${to} / ${total} dòng`}
        </span>
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5 text-gray-500">
            <span className="text-xs">Trang:</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Số dòng mỗi trang"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Trang trước"
        >
          ‹ Trước
        </button>
        <span className="text-gray-600 tabular-nums px-1">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Trang sau"
        >
          Sau ›
        </button>
      </div>
    </div>
  );
}
