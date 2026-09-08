/**
 * pages/roles/roles-list-page.tsx — List all RBAC roles with filter + create/edit/delete dialogs.
 *
 * Columns: Key | Mô tả | Ứng dụng | Nguồn | Ngày tạo | Thao tác
 * Filter: app dropdown (từ listApps) + search input (client-side, debounced 300ms)
 * Badge: source='manifest' → gray + tooltip; source='manual' → blue
 * Actions:
 *   - "Sửa permissions" (Phase 03): opens RolePermissionsDrawer for ALL roles (read-only for manifest)
 *   - "Sửa vai trò" (Phase 04): opens EditRoleDialog (manual only)
 *   - "Xoá" (Phase 04): opens DeleteRoleConfirmDialog (manual only)
 *
 * Polling: refetchInterval 30s keeps table fresh after outbox events.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { createColumnHelper } from '@tanstack/react-table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/data-table';
import { Pagination } from '@/components/pagination';
import { useRolesQuery } from '@/hooks/use-roles-query';
import { useAppsQuery } from '@/hooks/use-apps-query';
import { usePagination } from '@/hooks/use-pagination';
import { usePermissions } from '@/hooks/use-permissions';
import { debounce } from '@/lib/utils';
import { CreateRoleDialog } from './create-role-dialog';
import { RolePermissionsDrawer } from './role-permissions-drawer';
import { EditRoleDialog } from './edit-role-dialog';
import { DeleteRoleConfirmDialog } from './delete-role-confirm-dialog';
import type { Role } from '@/lib/types';

const col = createColumnHelper<Role>();

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function RolesListPage() {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [createOpen, setCreateOpen] = useState(false);

  // Phase 03: permissions drawer state
  const [drawerRoleKey, setDrawerRoleKey] = useState<string | null>(null);

  // Phase 04: edit + delete state
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [deletingRole, setDeletingRole] = useState<Role | null>(null);

  // refetchInterval 30s for polling outbox-driven sync state changes
  const { data: allRoles = [], isLoading, error, refetch } = useRolesQuery({ refetchInterval: 30_000 });
  const { data: apps = [] } = useAppsQuery();
  const { canWrite } = usePermissions();

  // Build app lookup map: id → app for display
  const appMap = useMemo(
    () => new Map(apps.map((a) => [a.id ?? '', a])),
    [apps],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSearch = useCallback(
    debounce((q: string) => setDebouncedQ(q), 300),
    [],
  );

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  }

  // Client-side filter: app dropdown + search
  const filtered = useMemo(() => {
    let rows = allRoles;

    if (selectedAppId) {
      rows = rows.filter((r) => r.app_id === selectedAppId);
    }

    if (debouncedQ.trim()) {
      const q = debouncedQ.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.key.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q),
      );
    }

    return rows;
  }, [allRoles, selectedAppId, debouncedQ]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, paged } =
    usePagination(filtered, 20);

  // Reset to page 1 whenever filter changes
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, selectedAppId, setPage]);

  // Defense in depth: auto-close any open drawer/dialog on route change so users navigating
  // via sidebar don't get stuck with a modal orphaned over the destination page.
  const { pathname } = useLocation();
  useEffect(() => {
    setDrawerRoleKey(null);
    setEditingRole(null);
    setDeletingRole(null);
    setCreateOpen(false);
  }, [pathname]);

  const columns = useMemo(
    () => [
      col.accessor('key', {
        header: 'Key',
        cell: (info) => (
          <span className="font-mono text-sm font-medium text-gray-900">
            {info.getValue()}
          </span>
        ),
      }),
      col.accessor('description', {
        header: 'Mô tả',
        cell: (info) => (
          <span className="text-sm text-gray-700">
            {info.getValue() || <span className="text-gray-400">—</span>}
          </span>
        ),
      }),
      col.accessor('app_id', {
        header: 'Ứng dụng',
        cell: (info) => {
          const appId = info.getValue();
          const app = appId ? appMap.get(appId) : null;
          if (!app) return <span className="text-gray-400 text-sm">—</span>;
          return (
            <span className="text-sm text-gray-700">
              {app.name}
              {app.slug && (
                <span className="ml-1 text-xs text-gray-400">({app.slug})</span>
              )}
            </span>
          );
        },
      }),
      col.accessor('source', {
        header: 'Nguồn',
        cell: (info) => {
          const source = info.getValue() ?? 'manual';
          if (source === 'manifest') {
            return (
              <span title="Do manifest quản lý — không thể sửa từ UI">
                <Badge variant="secondary">manifest</Badge>
              </span>
            );
          }
          return <Badge variant="default">manual</Badge>;
        },
      }),
      col.accessor('created_at', {
        header: 'Ngày tạo',
        cell: (info) => (
          <span className="text-sm text-gray-500">{formatDate(info.getValue())}</span>
        ),
      }),
      col.display({
        id: 'actions',
        header: 'Thao tác',
        cell: ({ row }) => {
          const role = row.original;
          const isManifest = (role.source ?? 'manual') === 'manifest';

          return (
            <div className="flex items-center gap-1">
              {/* Sửa permissions — all roles: drawer opens in read-only mode for manifest */}
              <button
                type="button"
                onClick={() => setDrawerRoleKey(role.key)}
                title={isManifest ? 'Xem permissions (read-only — manifest)' : 'Sửa permissions'}
                aria-label="Sửa permissions"
                className="rounded p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              >
                {/* Key/lock icon */}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </button>

              {/* Sửa vai trò — manual only */}
              <button
                type="button"
                disabled={isManifest || !canWrite()}
                onClick={() => !isManifest && canWrite() && setEditingRole(role)}
                title={isManifest ? 'Do manifest quản lý — không thể sửa' : 'Sửa vai trò'}
                aria-label="Sửa vai trò"
                className={`rounded p-1.5 transition-colors ${
                  isManifest || !canWrite()
                    ? 'text-gray-300 cursor-not-allowed'
                    : 'text-gray-500 hover:text-amber-600 hover:bg-amber-50'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>

              {/* Xoá — manual only */}
              <button
                type="button"
                disabled={isManifest || !canWrite()}
                onClick={() => !isManifest && canWrite() && setDeletingRole(role)}
                title={isManifest ? 'Do manifest quản lý — không thể xoá' : 'Xoá vai trò'}
                aria-label="Xoá vai trò"
                className={`rounded p-1.5 transition-colors ${
                  isManifest || !canWrite()
                    ? 'text-gray-300 cursor-not-allowed'
                    : 'text-gray-500 hover:text-red-600 hover:bg-red-50'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appMap, canWrite],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-gray-900">Vai trò</h1>

        {canWrite() && (
          <Button onClick={() => setCreateOpen(true)} size="sm">
            + Tạo vai trò mới
          </Button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select
          value={selectedAppId}
          onChange={(e) => setSelectedAppId(e.target.value)}
          aria-label="Lọc theo ứng dụng"
          className="w-full sm:w-52"
        >
          <option value="">Tất cả ứng dụng</option>
          {apps
            .filter((a) => a.registered && a.id && a.slug)
            .map((a) => (
              <option key={a.id} value={a.id!}>
                {a.name} ({a.slug})
              </option>
            ))}
        </Select>

        <Input
          value={searchInput}
          onChange={handleSearchChange}
          placeholder="Tìm theo key, mô tả..."
          className="w-full sm:max-w-sm"
          aria-label="Tìm kiếm vai trò"
        />

        {isLoading && (
          <span className="text-sm text-gray-400 shrink-0">Đang tải...</span>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-center gap-3 flex-wrap">
          <span>Không thể tải danh sách vai trò.</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Thử lại
          </Button>
        </div>
      )}

      {/* Table */}
      <DataTable
        data={paged}
        columns={columns}
        getRowId={(r) => r.key}
        emptyText={
          isLoading
            ? 'Đang tải...'
            : allRoles.length === 0
            ? "Chưa có vai trò nào. Nhấn 'Tạo vai trò mới' để bắt đầu."
            : 'Không tìm thấy vai trò phù hợp.'
        }
        mobileCard={(role) => {
          const app = role.app_id ? appMap.get(role.app_id) : null;
          const isManifest = (role.source ?? 'manual') === 'manifest';
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-medium text-gray-900 truncate">
                  {role.key}
                </span>
                <Badge variant={isManifest ? 'secondary' : 'default'}>
                  {role.source ?? 'manual'}
                </Badge>
              </div>
              {role.description && (
                <div className="text-xs text-gray-500 mt-0.5 truncate">{role.description}</div>
              )}
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-400 flex-wrap">
                {app && <span>{app.name}</span>}
                {role.created_at && <span>{formatDate(role.created_at)}</span>}
              </div>
              {/* Mobile action buttons */}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setDrawerRoleKey(role.key)}
                  className="text-xs text-blue-600 underline"
                >
                  Permissions
                </button>
                {!isManifest && canWrite() && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditingRole(role)}
                      className="text-xs text-amber-600 underline"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeletingRole(role)}
                      className="text-xs text-red-600 underline"
                    >
                      Xoá
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        }}
      />

      {/* Pagination */}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {/* Create dialog */}
      <CreateRoleDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Phase 03: Permissions drawer — all roles (read-only for manifest) */}
      <RolePermissionsDrawer
        roleKey={drawerRoleKey}
        onClose={() => setDrawerRoleKey(null)}
      />

      {/* Phase 04: Edit role dialog — manual roles only */}
      <EditRoleDialog
        role={editingRole}
        onClose={() => setEditingRole(null)}
      />

      {/* Phase 04: Delete confirm — manual roles only */}
      <DeleteRoleConfirmDialog
        role={deletingRole}
        onClose={() => setDeletingRole(null)}
      />
    </div>
  );
}
