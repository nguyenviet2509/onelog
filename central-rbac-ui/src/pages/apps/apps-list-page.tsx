/**
 * pages/apps/apps-list-page.tsx — Phase 07 app registry list view.
 * Displays all registered apps with quick actions: New App, Sync Manifest, Edit Manifest URL, Delete.
 * Supports multi-select for bulk delete.
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

  function toggleRowSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.checked) setSelectedIds(new Set(apps.map((a) => a.id)));
    else setSelectedIds(new Set());
  }

  const selectedApps = useMemo(
    () => apps.filter((a) => selectedIds.has(a.id)),
    [apps, selectedIds],
  );

  function handleSingleDelete() {
    if (!deletingApp) return;
    deleteMutation.mutate(deletingApp.id, {
      onSuccess: () => {
        toastSuccess(`Đã xoá ứng dụng ${deletingApp.slug}`);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Ứng dụng</h1>
          <p className="text-sm text-gray-500 mt-1">
            Đăng ký app OIDC + phân quyền qua Central RBAC.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            <Button>+ App mới</Button>
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

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-600 uppercase text-xs">
              <th className="px-4 py-3 w-8">
                <input
                  type="checkbox"
                  aria-label="Chọn tất cả"
                  checked={apps.length > 0 && selectedIds.size === apps.length}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
              </th>
              <th className="px-4 py-3 font-medium">Slug</th>
              <th className="px-4 py-3 font-medium">Tên</th>
              <th className="px-4 py-3 font-medium">Zitadel project</th>
              <th className="px-4 py-3 font-medium">Manifest</th>
              <th className="px-4 py-3 font-medium">Tạo lúc</th>
              <th className="px-4 py-3 font-medium">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Chọn ${app.slug}`}
                    checked={selectedIds.has(app.id)}
                    onChange={() => toggleRowSelect(app.id)}
                    className="rounded"
                  />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-700">{app.slug}</td>
                <td className="px-4 py-3 text-gray-900">{app.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">
                  {app.zitadel_project_id ?? <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-3">
                  {app.manifest_url ? (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {app.manifest_url.replace(/^https?:\/\//, '').slice(0, 30)}…
                    </Badge>
                  ) : (
                    <span className="text-gray-400">chưa cấu hình</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {new Date(app.created_at).toLocaleString('vi-VN')}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
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
                </td>
              </tr>
            ))}
            {!isLoading && apps.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500 text-sm">
                  Chưa có app nào. Bấm <strong>+ App mới</strong> để bắt đầu.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editingApp && (
        <EditManifestUrlDialog
          app={editingApp}
          open={!!editingApp}
          onOpenChange={(open) => !open && setEditingApp(null)}
        />
      )}

      {deletingApp && (
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
