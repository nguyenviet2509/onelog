/**
 * hooks/use-pagination.ts — Client-side pagination over an in-memory array.
 *
 * Data đã fetch trọn (users tối đa 200, apps unbounded nhưng thực tế < 100).
 * Server pagination có thể thêm sau khi dữ liệu vượt 200; tạm client-side là đủ.
 */
import { useEffect, useMemo, useState } from 'react';

export interface UsePaginationResult<T> {
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  totalPages: number;
  total: number;
  paged: T[];
}

const DEFAULT_PAGE_SIZE = 20;

export function usePagination<T>(
  data: T[],
  initialPageSize: number = DEFAULT_PAGE_SIZE,
): UsePaginationResult<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Clamp page when data shrinks (search filter, delete, page size change).
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  function setPageSize(n: number) {
    setPageSizeState(n);
    setPage(1);
  }

  const paged = useMemo(
    () => data.slice((page - 1) * pageSize, page * pageSize),
    [data, page, pageSize],
  );

  return { page, setPage, pageSize, setPageSize, totalPages, total, paged };
}
