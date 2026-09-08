/**
 * pages/roles/create-role-dialog.tsx — Dialog to create a new RBAC role.
 *
 * Fields:
 *   - App dropdown (required) — selected app auto-shows key prefix "{slug}."
 *   - Key suffix input (required, regex ^[a-z][a-z0-9-]*$)
 *   - Description textarea (optional, max 200 chars)
 *   - Parent role dropdown (optional, filtered to same app_id)
 *
 * On success: toast + invalidate ['roles'] query + close dialog.
 * On error: inline error message without closing.
 */
import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAppsQuery } from '@/hooks/use-apps-query';
import { useRolesQuery, useCreateRoleMutation } from '@/hooks/use-roles-query';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';

interface CreateRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const schema = z.object({
  app_id: z.string().uuid('Vui lòng chọn ứng dụng'),
  key_suffix: z
    .string()
    .min(1, 'Key không được để trống')
    .regex(/^[a-z][a-z0-9-]*$/, 'Chỉ chữ thường, số và dấu gạch nối; phải bắt đầu bằng chữ'),
  description: z.string().max(200, 'Mô tả tối đa 200 ký tự').optional(),
  parent_key: z.string().nullable().optional(),
});

type FormValues = z.infer<typeof schema>;

export function CreateRoleDialog({ open, onOpenChange }: CreateRoleDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: apps = [], isLoading: appsLoading } = useAppsQuery();
  const { data: roles = [] } = useRolesQuery();
  const mutation = useCreateRoleMutation();

  const registeredApps = useMemo(() => apps.filter((a) => a.registered && a.id && a.slug), [apps]);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: {
      app_id: '',
      key_suffix: '',
      description: '',
      parent_key: null,
    },
  });

  const selectedAppId = watch('app_id');
  const selectedApp = useMemo(
    () => registeredApps.find((a) => a.id === selectedAppId),
    [registeredApps, selectedAppId],
  );

  // Parent role candidates: roles belonging to selected app only
  const parentCandidates = useMemo(
    () => roles.filter((r) => r.app_id === selectedAppId),
    [roles, selectedAppId],
  );

  function handleOpenChange(v: boolean) {
    if (!v) {
      reset();
      setServerError(null);
    }
    onOpenChange(v);
  }

  function onSubmit(values: FormValues) {
    if (!selectedApp?.slug) return;
    setServerError(null);

    const key = `${selectedApp.slug}.${values.key_suffix}`;
    mutation.mutate(
      {
        key,
        description: values.description || undefined,
        app_id: values.app_id,
        parent_key: values.parent_key || null,
      },
      {
        onSuccess: () => {
          toastSuccess(`Đã tạo vai trò "${key}" thành công.`);
          reset();
          onOpenChange(false);
        },
        onError: (err) => {
          const axiosErr = err as AxiosError<{ error?: string; detail?: string }>;
          const msg =
            axiosErr.response?.data?.error ??
            axiosErr.response?.data?.detail ??
            'Không thể tạo vai trò. Vui lòng thử lại.';
          setServerError(msg);
          toastError(msg);
        },
      },
    );
  }

  const canSubmit = isValid && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title="Tạo vai trò mới" description="Vai trò sẽ được đồng bộ sang Zitadel sau vài giây.">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>

          {/* App dropdown */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Ứng dụng <span className="text-red-500">*</span>
            </label>
            <Select {...register('app_id')} disabled={appsLoading} aria-label="Chọn ứng dụng">
              <option value="">— Chọn ứng dụng —</option>
              {registeredApps.map((app) => (
                <option key={app.id} value={app.id!}>
                  {app.name} ({app.slug})
                </option>
              ))}
            </Select>
            {errors.app_id && (
              <p className="text-xs text-red-600 mt-1">{errors.app_id.message}</p>
            )}
          </div>

          {/* Key suffix with prefix display */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Key vai trò <span className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-0 rounded-md border border-gray-300 overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
              {selectedApp?.slug && (
                <span className="px-3 py-2 text-sm bg-gray-50 text-gray-500 border-r border-gray-300 shrink-0 select-none">
                  {selectedApp.slug}.
                </span>
              )}
              <Input
                {...register('key_suffix')}
                placeholder={selectedApp ? 'approver' : 'Chọn ứng dụng trước'}
                disabled={!selectedApp}
                className="border-0 rounded-none focus:ring-0 focus:outline-none"
                aria-label="Key suffix"
              />
            </div>
            {selectedApp && (
              <p className="text-xs text-gray-400 mt-1">
                Key đầy đủ: <code className="font-mono">{selectedApp.slug}.{watch('key_suffix') || '…'}</code>
              </p>
            )}
            {errors.key_suffix && (
              <p className="text-xs text-red-600 mt-1">{errors.key_suffix.message}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mô tả</label>
            <textarea
              {...register('description')}
              rows={2}
              maxLength={200}
              placeholder="Mô tả ngắn về vai trò này (tuỳ chọn)"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            {errors.description && (
              <p className="text-xs text-red-600 mt-1">{errors.description.message}</p>
            )}
          </div>

          {/* Parent role dropdown (optional) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Vai trò cha <span className="text-gray-400 font-normal">(tuỳ chọn)</span>
            </label>
            <Select
              {...register('parent_key')}
              disabled={!selectedApp || parentCandidates.length === 0}
              aria-label="Chọn vai trò cha"
            >
              <option value="">— Không có —</option>
              {parentCandidates.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.key}
                  {r.description ? ` — ${r.description}` : ''}
                </option>
              ))}
            </Select>
            {selectedApp && parentCandidates.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">Chưa có vai trò nào trong ứng dụng này để làm cha.</p>
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
              <Button type="button" variant="outline" disabled={mutation.isPending}>
                Hủy
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? 'Đang tạo...' : 'Tạo vai trò'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
