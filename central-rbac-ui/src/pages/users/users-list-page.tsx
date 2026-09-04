/**
 * pages/users/users-list-page.tsx — Users table with search (debounced 300ms),
 * row-click drawer, checkbox multi-select, and bulk assign trigger.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { createColumnHelper } from '@tanstack/react-table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/data-table';
import { Pagination } from '@/components/pagination';
import { useUsersQuery } from '@/hooks/use-users-query';
import { usePagination } from '@/hooks/use-pagination';
import { usePermissions } from '@/hooks/use-permissions';
import { debounce } from '@/lib/utils';
import { UserDetailDrawer } from './user-detail-drawer';
import { BulkAssignDialog } from './bulk-assign-dialog';
import { BulkDeleteUsersDialog } from './bulk-delete-users-dialog';
import { CreateUserDialog } from './create-user-dialog';
import type { ZitadelUser } from '@/lib/types';

const col = createColumnHelper<ZitadelUser>();

export function UsersListPage() {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: users = [], isLoading, error, refetch } = useUsersQuery(debouncedQ);
  const { canWrite } = usePermissions();
  const { page, setPage, pageSize, setPageSize, totalPages, total, paged } = usePagination(users, 20);

  // Reset về trang 1 khi search thay đổi (kể cả khi tổng số trang vẫn ≥ page hiện tại).
  useEffect(() => { setPage(1); }, [debouncedQ, setPage]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSearch = useCallback(
    debounce((q: string) => setDebouncedQ(q), 300),
    [],
  );

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  }

  function toggleRowSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Select-all áp dụng cho trang hiện tại (thói quen chuẩn của bảng phân trang).
  function toggleSelectAll(e: React.ChangeEvent<HTMLInputElement>) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (e.target.checked) paged.forEach((u) => next.add(u.id));
      else paged.forEach((u) => next.delete(u.id));
      return next;
    });
  }

  const selectedUserObjects = useMemo(
    () => users.filter((u) => selectedRows.has(u.id)),
    [users, selectedRows],
  );

  const columns = useMemo(() => [
    col.display({
      id: 'select',
      header: () => (
        <input
          type="checkbox"
          aria-label="Chọn tất cả trang này"
          checked={paged.length > 0 && paged.every((u) => selectedRows.has(u.id))}
          onChange={toggleSelectAll}
          className="rounded"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`Chọn ${row.original.email}`}
          checked={selectedRows.has(row.original.id)}
          // H5 fix: readOnly suppresses React controlled-input warning;
          // selection is driven by onClick (toggleRowSelect) not onChange.
          readOnly
          onClick={(e) => toggleRowSelect(row.original.id, e)}
          className="rounded"
        />
      ),
    }),
    col.accessor('email', {
      header: 'Email',
      cell: (info) => <span className="font-medium text-gray-900">{info.getValue()}</span>,
    }),
    col.accessor('display_name', {
      header: 'Tên hiển thị',
    }),
    col.accessor('organization', {
      header: 'Tổ chức',
      cell: (info) => {
        const org = info.getValue();
        return org?.name ? (
          <span className="text-sm text-gray-700">{org.name}</span>
        ) : (
          <span className="text-gray-400">—</span>
        );
      },
    }),
    col.accessor('grant_count', {
      header: 'Số quyền',
      cell: (info) => {
        const count = info.getValue();
        // H4: grant_count is null in list (lazy-loaded on drawer open)
        if (count === null || count === undefined) {
          return <span className="text-gray-400 text-sm">—</span>;
        }
        return (
          <Badge variant={count > 0 ? 'default' : 'secondary'}>
            {count}
          </Badge>
        );
      },
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [paged, selectedRows]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-gray-900">Người dùng</h1>

        <div className="flex items-center gap-2 flex-wrap">
          {canWrite() && selectedRows.size > 0 && (
            <>
              <Button onClick={() => setBulkOpen(true)} size="sm">
                Cấp quyền ({selectedRows.size})
              </Button>
              <Button
                onClick={() => setBulkDeleteOpen(true)}
                size="sm"
                variant="destructive"
              >
                Xoá ({selectedRows.size})
              </Button>
            </>
          )}
          {canWrite() && (
            <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
              + Tạo người dùng
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Input
          value={searchInput}
          onChange={handleSearchChange}
          placeholder="Tìm kiếm theo email, tên..."
          className="w-full sm:max-w-sm"
          aria-label="Tìm kiếm người dùng"
        />
        {isLoading && (
          <span className="text-sm text-gray-400 shrink-0">Đang tải...</span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-center gap-3 flex-wrap">
          <span>Không thể tải danh sách người dùng.</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Thử lại
          </Button>
        </div>
      )}

      <DataTable
        data={paged}
        columns={columns}
        onRowClick={(user) => setSelectedUserId(user.id)}
        getRowId={(u) => u.id}
        emptyText="Không có người dùng"
        mobileCard={(user) => (
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              aria-label={`Chọn ${user.email}`}
              checked={selectedRows.has(user.id)}
              readOnly
              onClick={(e) => toggleRowSelect(user.id, e)}
              className="mt-1 rounded shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-gray-900 truncate">{user.email}</div>
              {user.display_name && (
                <div className="text-xs text-gray-500 truncate">{user.display_name}</div>
              )}
              <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                {user.organization?.name && (
                  <span className="text-gray-600 truncate max-w-[60%]">
                    {user.organization.name}
                  </span>
                )}
                {user.grant_count !== null && user.grant_count !== undefined && (
                  <Badge variant={user.grant_count > 0 ? 'default' : 'secondary'}>
                    {user.grant_count} quyền
                  </Badge>
                )}
              </div>
            </div>
          </div>
        )}
      />

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <UserDetailDrawer
        userId={selectedUserId}
        onClose={() => setSelectedUserId(null)}
      />

      <BulkAssignDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        selectedUsers={selectedUserObjects}
      />

      <BulkDeleteUsersDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        selectedUsers={selectedUserObjects}
        onDone={() => setSelectedRows(new Set())}
      />

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
