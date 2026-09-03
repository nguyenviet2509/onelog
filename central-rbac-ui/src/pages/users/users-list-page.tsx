/**
 * pages/users/users-list-page.tsx — Users table with search (debounced 300ms),
 * row-click drawer, checkbox multi-select, and bulk assign trigger.
 */
import { useState, useCallback, useMemo } from 'react';
import { createColumnHelper } from '@tanstack/react-table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/data-table';
import { useUsersQuery } from '@/hooks/use-users-query';
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

  function toggleSelectAll(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.checked) setSelectedRows(new Set(users.map((u) => u.id)));
    else setSelectedRows(new Set());
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
          aria-label="Chọn tất cả"
          checked={users.length > 0 && selectedRows.size === users.length}
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
  ], [users, selectedRows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-gray-900">Người dùng</h1>

        <div className="flex items-center gap-2">
          {canWrite() && selectedRows.size > 0 && (
            <>
              <Button onClick={() => setBulkOpen(true)} size="sm">
                Cấp quyền hàng loạt ({selectedRows.size})
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
          className="max-w-sm"
          aria-label="Tìm kiếm người dùng"
        />
        {isLoading && (
          <span className="text-sm text-gray-400">Đang tải...</span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-center gap-3">
          <span>Không thể tải danh sách người dùng.</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Thử lại
          </Button>
        </div>
      )}

      <DataTable
        data={users}
        columns={columns}
        onRowClick={(user) => setSelectedUserId(user.id)}
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
