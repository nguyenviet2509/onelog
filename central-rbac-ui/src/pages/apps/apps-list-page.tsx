/**
 * pages/apps/apps-list-page.tsx — Central RBAC app registry list.
 *
 * Post multi-org rewrite (2026-09-04): lists every Zitadel project across
 * every org (registered + unregistered) with an Org column. Registered rows
 * expose Sync/Sửa URL/Xoá; unregistered rows are read-only ("chưa đăng ký")
 * with no destructive actions.
 *
 * Multi-select + bulk delete only applies to registered rows (checkbox
 * disabled for unregistered).
 */
import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAppsQuery, useDeleteAppMutation } from '@/hooks/use-apps-query';
import { EditManifestUrlDialog } from './edit-manifest-url-dialog';
import { BulkDeleteAppsDialog } from './bulk-delete-apps-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { App } from '@/api/apps';

export function AppsListPage() {
  const { data: apps = [], isLoading, error, refetch } = useAppsQuery();
  const [editingApp, setEditingApp] = useState<App | null>(null);
  const [deletingApp, setDeletingApp] = useState<App | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const deleteMutation = useDeleteAppMutation();

  const registeredApps = useMemo(() => apps.filter((a) => a.registered && a.id), [apps]);

  function toggleRowSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.checked) setSelectedIds(new Set(registeredApps.map((a) => a.id!)));
    else setSelectedIds(new Set());
  }

  const selectedApps = useMemo(
    () => registeredApps.filter((a) => selectedIds.has(a.id!)),
    [registeredApps, selectedIds],
  );

  function handleSingleDelete() {
    if (!deletingApp?.id) return;
    const id = deletingApp.id;
    const label = deletingApp.slug ?? deletingApp.name;
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toastSuccess(`Đã xoá ứng dụng ${label}`);
        setDeletingApp(null);
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Xoá thất bại';
        toastError(msg);
      },
    });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Ứng dụng</h1>
          <p className="text-sm text-gray-500 mt-1">
            Toàn bộ Zitadel project across các tổ chức. App đã đăng ký có thể cấp quyền + đồng bộ manifest.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedIds.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              Xoá ({selectedIds.size})
            </Button>
          )}
          <Link to="/apps/new">
            <Button size="sm">+ App mới</Button>
          </Link>
        </div>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Đang tải...</p>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md p-3">
          Lỗi tải danh sách: {error instanceof Error ? error.message : String(error)}
          <button onClick={() => refetch()} className="ml-3 underline">Thử lại</button>
        </div>
      )}

      {/* Mobile card list — < md */}
      <div className="md:hidden space-y-2">
        {!isLoading && apps.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-gray-500 text-sm">
            Chưa có project nào trong Zitadel. Bấm <strong>+ App mới</strong> để tạo.
          </div>
        )}
        {apps.map((app) => {
          const rowKey = app.zitadel_project_id ?? app.id ?? `${app.name}-${app.org_name ?? ''}`;
          const canSelect = app.registered && !!app.id;
          return (
            <div
              key={rowKey}
              className={`rounded-lg border border-gray-200 p-3 ${app.registered ? 'bg-white' : 'bg-gray-50/60'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={`Chọn ${app.slug ?? app.name}`}
                  checked={canSelect && selectedIds.has(app.id!)}
                  onChange={() => canSelect && toggleRowSelect(app.id!)}
                  disabled={!canSelect}
                  className="mt-1 rounded shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {app.registered ? (
                      <Badge variant="default">đã đăng ký</Badge>
                    ) : (
                      <Badge variant="secondary">chưa đăng ký</Badge>
                    )}
                    <span className="font-medium text-gray-900 truncate">{app.name}</span>
                  </div>
                  {app.org_name && (
                    <div className="mt-1 text-xs text-gray-600 truncate">Tổ chức: {app.org_name}</div>
                  )}
                  {app.slug && (
                    <div className="mt-0.5 text-xs font-mono text-gray-500 truncate">{app.slug}</div>
                  )}
                  {app.manifest_url && (
                    <div className="mt-0.5 text-xs font-mono text-gray-400 truncate">
                      {app.manifest_url.replace(/^https?:\/\//, '')}
                    </div>
                  )}
                  {app.registered && app.id ? (
                    <div className="mt-2 flex gap-2 flex-wrap">
                      <Link to={`/apps/${app.id}/manifest`}>
                        <Button size="sm" variant="outline">Sync</Button>
                      </Link>
                      <Button size="sm" variant="ghost" onClick={() => setEditingApp(app)}>
                        Sửa URL
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeletingApp(app)}>
                        Xoá
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-gray-400">chỉ hiển thị</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table — ≥ md */}
      <div className="hidden md:block bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-600 uppercase text-xs">
              <th className="px-4 py-3 w-8">
                <input
                  type="checkbox"
                  aria-label="Chọn tất cả app đã đăng ký"
                  checked={registeredApps.length > 0 && selectedIds.size === registeredApps.length}
                  onChange={toggleSelectAll}
                  className="rounded"
                  disabled={registeredApps.length === 0}
                />
              </th>
              <th className="px-4 py-3 font-medium">Trạng thái</th>
              <th className="px-4 py-3 font-medium">Tên</th>
              <th className="px-4 py-3 font-medium">Tổ chức</th>
              <th className="px-4 py-3 font-medium">Slug</th>
              <th className="px-4 py-3 font-medium hidden lg:table-cell">Zitadel project</th>
              <th className="px-4 py-3 font-medium hidden lg:table-cell">Manifest</th>
              <th className="px-4 py-3 font-medium">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => {
              const rowKey = app.zitadel_project_id ?? app.id ?? `${app.name}-${app.org_name ?? ''}`;
              const canSelect = app.registered && !!app.id;
              return (
                <tr
                  key={rowKey}
                  className={`border-b border-gray-100 hover:bg-gray-50 ${app.registered ? '' : 'bg-gray-50/40'}`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Chọn ${app.slug ?? app.name}`}
                      checked={canSelect && selectedIds.has(app.id!)}
                      onChange={() => canSelect && toggleRowSelect(app.id!)}
                      disabled={!canSelect}
                      className="rounded"
                    />
                  </td>
                  <td className="px-4 py-3">
                    {app.registered ? (
                      <Badge variant="default">đã đăng ký</Badge>
                    ) : (
                      <Badge variant="secondary">chưa đăng ký</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-900">{app.name}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {app.org_name ?? <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">
                    {app.slug ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500 hidden lg:table-cell">
                    {app.zitadel_project_id ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {app.manifest_url ? (
                      <Badge variant="secondary" className="font-mono text-xs">
                        {app.manifest_url.replace(/^https?:\/\//, '').slice(0, 30)}…
                      </Badge>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {app.registered && app.id ? (
                      <div className="flex gap-2 flex-wrap">
                        <Link to={`/apps/${app.id}/manifest`}>
                          <Button size="sm" variant="outline">
                            Sync
                          </Button>
                        </Link>
                        <Button size="sm" variant="ghost" onClick={() => setEditingApp(app)}>
                          Sửa URL
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setDeletingApp(app)}
                        >
                          Xoá
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">chỉ hiển thị</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!isLoading && apps.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500 text-sm">
                  Chưa có project nào trong Zitadel. Bấm <strong>+ App mới</strong> để tạo.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editingApp && editingApp.id && (
        <EditManifestUrlDialog
          app={editingApp}
          open={!!editingApp}
          onOpenChange={(open) => !open && setEditingApp(null)}
        />
      )}

      {deletingApp && deletingApp.slug && (
        <ConfirmDialog
          open={!!deletingApp}
          onOpenChange={(open) => !open && setDeletingApp(null)}
          title="Xoá vĩnh viễn ứng dụng"
          description={`Ứng dụng ${deletingApp.slug} (${deletingApp.name}) sẽ bị xoá: Zitadel project + roles nội bộ. Không thể hoàn tác.`}
          typeVerify={deletingApp.slug}
          typeVerifyLabel={`Nhập slug "${deletingApp.slug}" để xác nhận:`}
          confirmLabel="Xoá vĩnh viễn"
          variant="destructive"
          isLoading={deleteMutation.isPending}
          onConfirm={handleSingleDelete}
        />
      )}

      <BulkDeleteAppsDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        selectedApps={selectedApps}
        onDone={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
