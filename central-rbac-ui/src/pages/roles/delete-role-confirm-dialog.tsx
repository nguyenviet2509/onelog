/**
 * pages/roles/delete-role-confirm-dialog.tsx — Confirm before deleting an RBAC role.
 *
 * Note: Backend GET /v1/assignments requires user_id (no role_key filter) and
 * GET /v1/roles/:key/stats returns permission counts, not user assignment counts.
 * User count per role is not available from current API.
 * TODO: when BE exposes GET /v1/roles/:key/grants count, wire it here for user warning.
 *
 * Current UX: simple confirmation with role key typed to confirm (safety guard).
 * Manifest roles are not reachable here — parent disables the delete button for them.
 *
 * On success: toast + invalidate ['roles'] + close.
 */
import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDeleteRoleMutation } from '@/hooks/use-roles-query';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';
import type { Role } from '@/lib/types';

interface DeleteRoleConfirmDialogProps {
  role: Role | null;
  onClose: () => void;
}

export function DeleteRoleConfirmDialog({ role, onClose }: DeleteRoleConfirmDialogProps) {
  const [confirmInput, setConfirmInput] = useState('');
  const mutation = useDeleteRoleMutation();

  // Reset input whenever the dialog opens for a new role
  useEffect(() => {
    if (role) setConfirmInput('');
  }, [role?.key]);

  function handleClose() {
    setConfirmInput('');
    onClose();
  }

  async function handleDelete() {
    if (!role || confirmInput !== role.key) return;

    mutation.mutate(role.key, {
      onSuccess: () => {
        toastSuccess(`Đã xoá vai trò "${role.key}".`);
        handleClose();
      },
      onError: (err) => {
        const axiosErr = err as AxiosError<{ error?: string; detail?: string }>;
        const msg =
          axiosErr.response?.data?.error ??
          axiosErr.response?.data?.detail ??
          'Không thể xoá vai trò. Vui lòng thử lại.';
        toastError(msg);
      },
    });
  }

  const canDelete = confirmInput === (role?.key ?? '') && !mutation.isPending;

  return (
    <Dialog open={!!role} onOpenChange={(open) => { if (!open) handleClose(); }} modal={false}>
      <DialogContent
        title="Xoá vai trò"
        description="Hành động này không thể hoàn tác. Vai trò sẽ bị xoá khỏi hệ thống và Zitadel."
        nonModal
      >
        <div className="space-y-4">
          {/* Warning */}
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 space-y-1">
            <p className="font-semibold">
              Cảnh báo: xoá vai trò sẽ gỡ quyền của tất cả người dùng đang có vai trò này.
            </p>
            <p>
              Vai trò sẽ được xoá khỏi Zitadel qua outbox worker trong vài giây.
            </p>
          </div>

          {/* Role info */}
          <div className="rounded-md bg-gray-50 border border-gray-200 px-4 py-3 space-y-1">
            <div className="text-xs text-gray-500">Key vai trò</div>
            <div className="font-mono text-sm font-semibold text-gray-900">{role?.key}</div>
            {role?.description && (
              <>
                <div className="text-xs text-gray-500 mt-1">Mô tả</div>
                <div className="text-sm text-gray-700">{role.description}</div>
              </>
            )}
          </div>

          {/* Type-to-confirm */}
          <div>
            <label className="block text-sm text-gray-700 mb-1.5">
              Nhập key vai trò{' '}
              <code className="px-1 py-0.5 bg-gray-100 rounded font-mono text-xs">
                {role?.key}
              </code>{' '}
              để xác nhận:
            </label>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={role?.key ?? ''}
              autoComplete="off"
              disabled={mutation.isPending}
              aria-label="Xác nhận key vai trò"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={handleClose}
              >
                Hủy
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!canDelete}
              onClick={handleDelete}
            >
              {mutation.isPending ? 'Đang xoá...' : 'Xoá vai trò'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
