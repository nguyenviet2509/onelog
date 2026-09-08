/**
 * pages/roles/edit-role-dialog.tsx — Edit an existing RBAC role.
 *
 * Editable fields: description, parent_key
 * Read-only display: key, app_slug
 * Guard: only called for source='manual' roles (parent disables button for manifest).
 *
 * On success: toast + invalidate ['roles'] + close.
 * On error: inline server error without closing.
 */
import { useState, useMemo, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useRolesQuery, useUpdateRoleMutation } from '@/hooks/use-roles-query';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';
import type { Role } from '@/lib/types';

interface EditRoleDialogProps {
  role: Role | null;
  onClose: () => void;
}

const schema = z.object({
  description: z.string().max(200, 'Mô tả tối đa 200 ký tự').optional(),
  parent_key: z.string().nullable().optional(),
});

type FormValues = z.infer<typeof schema>;

export function EditRoleDialog({ role, onClose }: EditRoleDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: roles = [] } = useRolesQuery();
  const mutation = useUpdateRoleMutation();

  // Parse app_slug from role key prefix: "qlts.approver" → "qlts"
  const appSlug = useMemo(() => {
    if (!role?.key) return null;
    const dot = role.key.indexOf('.');
    return dot > 0 ? role.key.slice(0, dot) : null;
  }, [role?.key]);

  // Parent candidates: roles in same app (by key prefix), excluding self
  const parentCandidates = useMemo(() => {
    if (!role || !appSlug) return [];
    return roles.filter(
      (r) => r.key !== role.key && (appSlug ? r.key.startsWith(`${appSlug}.`) : r.app_id === role.app_id),
    );
  }, [roles, role, appSlug]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
  });

  // Reset form whenever the role being edited changes
  useEffect(() => {
    if (role) {
      reset({
        description: role.description ?? '',
        parent_key: role.parent_key ?? null,
      });
      setServerError(null);
    }
  }, [role, reset]);

  function handleClose() {
    reset();
    setServerError(null);
    onClose();
  }

  function onSubmit(values: FormValues) {
    if (!role) return;
    setServerError(null);

    mutation.mutate(
      {
        key: role.key,
        input: {
          description: values.description || undefined,
          parent_key: values.parent_key ?? null,
        },
      },
      {
        onSuccess: () => {
          toastSuccess(`Đã cập nhật vai trò "${role.key}".`);
          handleClose();
        },
        onError: (err) => {
          const axiosErr = err as AxiosError<{ error?: string; detail?: string }>;
          const msg =
            axiosErr.response?.data?.error ??
            axiosErr.response?.data?.detail ??
            'Không thể cập nhật vai trò. Vui lòng thử lại.';
          setServerError(msg);
          toastError(msg);
        },
      },
    );
  }

  const canSubmit = isDirty && !mutation.isPending;

  return (
    <Dialog open={!!role} onOpenChange={(open) => { if (!open) handleClose(); }} modal={false}>
      <DialogContent
        title="Sửa vai trò"
        description="Chỉ có thể sửa mô tả và vai trò cha. Key vai trò là bất biến."
        nonModal
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>

          {/* Role key — read-only display */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Key vai trò</label>
            <div className="flex items-center gap-2">
              {appSlug && (
                <span className="px-3 py-2 text-sm bg-gray-50 text-gray-500 border border-gray-300 rounded-md select-none">
                  {appSlug}
                </span>
              )}
              <span className="flex-1 px-3 py-2 text-sm bg-gray-50 text-gray-700 border border-gray-300 rounded-md font-mono select-none">
                {role?.key ?? ''}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">Key không thể thay đổi sau khi tạo.</p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mô tả</label>
            <textarea
              {...register('description')}
              rows={2}
              maxLength={200}
              placeholder="Mô tả ngắn về vai trò này (tuỳ chọn)"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
            {errors.description && (
              <p className="text-xs text-red-600 mt-1">{errors.description.message}</p>
            )}
          </div>

          {/* Parent role */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Vai trò cha <span className="text-gray-400 font-normal">(tuỳ chọn)</span>
            </label>
            <Select
              {...register('parent_key')}
              disabled={parentCandidates.length === 0}
              aria-label="Chọn vai trò cha"
            >
              <option value="">— Không có —</option>
              {parentCandidates.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.key}{r.description ? ` — ${r.description}` : ''}
                </option>
              ))}
            </Select>
            {parentCandidates.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">
                Không có vai trò nào trong cùng ứng dụng để làm cha.
              </p>
            )}
          </div>

          {/* Server error */}
          {serverError && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {serverError}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending} onClick={handleClose}>
                Hủy
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
