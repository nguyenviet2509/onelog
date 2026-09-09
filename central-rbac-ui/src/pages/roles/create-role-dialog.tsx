/**
 * pages/roles/create-role-dialog.tsx — Dialog to create one OR many RBAC roles.
 *
 * Fields:
 *   - App dropdown (required) — selected app auto-shows key prefix "{slug}."
 *   - Multi-line textarea (required) — one role per line:
 *       "suffix"              → key = "{slug}.suffix"
 *       "suffix | description" → key + description in one shot
 *   - Parent role dropdown (optional, applies to ALL rows in batch)
 *
 * On submit: parses lines, POSTs concurrently, reports per-key success/failure.
 */
import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useAppsQuery } from '@/hooks/use-apps-query';
import { useRolesQuery, useCreateRoleMutation } from '@/hooks/use-roles-query';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { AxiosError } from 'axios';

interface CreateRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const suffixRegex = /^[a-z][a-z0-9-]*$/;

const schema = z.object({
  app_id: z.string().uuid('Vui lòng chọn ứng dụng'),
  keys_raw: z
    .string()
    .min(1, 'Nhập ít nhất một key vai trò')
    .refine((v) => v.split('\n').some((l) => l.trim().length > 0), 'Nhập ít nhất một key vai trò'),
  parent_key: z.string().nullable().optional(),
});

type FormValues = z.infer<typeof schema>;

interface ParsedRow {
  suffix: string;
  description: string;
  lineNo: number;
}

interface ParseResult {
  rows: ParsedRow[];
  errors: string[];
}

function parseKeysRaw(raw: string): ParseResult {
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [rawSuffix, ...descParts] = trimmed.split('|');
    const suffix = (rawSuffix ?? '').trim();
    const description = descParts.join('|').trim();
    if (!suffixRegex.test(suffix)) {
      errors.push(`Dòng ${idx + 1}: "${suffix}" không hợp lệ (chữ thường, số, dấu gạch nối, bắt đầu bằng chữ)`);
      return;
    }
    if (seen.has(suffix)) {
      errors.push(`Dòng ${idx + 1}: "${suffix}" bị trùng`);
      return;
    }
    seen.add(suffix);
    rows.push({ suffix, description, lineNo: idx + 1 });
  });
  return { rows, errors };
}

export function CreateRoleDialog({ open, onOpenChange }: CreateRoleDialogProps) {
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      keys_raw: '',
      parent_key: null,
    },
  });

  const selectedAppId = watch('app_id');
  const keysRaw = watch('keys_raw');
  const selectedApp = useMemo(
    () => registeredApps.find((a) => a.id === selectedAppId),
    [registeredApps, selectedAppId],
  );

  const parentCandidates = useMemo(
    () => roles.filter((r) => r.app_id === selectedAppId),
    [roles, selectedAppId],
  );

  const preview = useMemo(() => (keysRaw ? parseKeysRaw(keysRaw) : { rows: [], errors: [] }), [keysRaw]);

  function handleOpenChange(v: boolean) {
    if (!v) {
      reset();
      setServerErrors([]);
    }
    onOpenChange(v);
  }

  async function onSubmit(values: FormValues) {
    if (!selectedApp?.slug) return;
    const parsed = parseKeysRaw(values.keys_raw);
    if (parsed.errors.length > 0) {
      setServerErrors(parsed.errors);
      return;
    }
    if (parsed.rows.length === 0) {
      setServerErrors(['Không có key hợp lệ để tạo']);
      return;
    }

    setServerErrors([]);
    setIsSubmitting(true);

    const results = await Promise.allSettled(
      parsed.rows.map((row) =>
        mutation.mutateAsync({
          key: `${selectedApp.slug}.${row.suffix}`,
          description: row.description || undefined,
          app_id: values.app_id,
          parent_key: values.parent_key || null,
        }),
      ),
    );

    const failures: string[] = [];
    let ok = 0;
    results.forEach((r, i) => {
      const key = `${selectedApp.slug}.${parsed.rows[i]!.suffix}`;
      if (r.status === 'fulfilled') {
        ok += 1;
      } else {
        const err = r.reason as AxiosError<{ error?: string; detail?: string }>;
        const msg = err.response?.data?.error ?? err.response?.data?.detail ?? err.message ?? 'Lỗi không rõ';
        failures.push(`${key}: ${msg}`);
      }
    });

    setIsSubmitting(false);

    if (ok > 0) {
      toastSuccess(`Đã tạo ${ok}/${parsed.rows.length} vai trò`);
    }
    if (failures.length > 0) {
      setServerErrors(failures);
      toastError(`${failures.length} vai trò tạo thất bại`);
      return;
    }
    reset();
    onOpenChange(false);
  }

  const canSubmit = isValid && !isSubmitting && preview.rows.length > 0 && preview.errors.length === 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title="Tạo vai trò mới" description="Có thể tạo nhiều vai trò cùng lúc — mỗi dòng một key.">
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

          {/* Multi-line keys textarea */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Danh sách key vai trò <span className="text-red-500">*</span>
            </label>
            <textarea
              {...register('keys_raw')}
              rows={5}
              disabled={!selectedApp}
              placeholder={selectedApp ? 'approver\nmanager | Quản lý toàn bộ\nreadonly | Chỉ đọc' : 'Chọn ứng dụng trước'}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Danh sách key vai trò"
            />
            <p className="text-xs text-gray-500 mt-1">
              Mỗi dòng một key. Định dạng: <code className="font-mono">suffix</code> hoặc{' '}
              <code className="font-mono">suffix | mô tả</code>. Ví dụ:{' '}
              <code className="font-mono">approver | Duyệt yêu cầu</code>
            </p>
            {errors.keys_raw && (
              <p className="text-xs text-red-600 mt-1">{errors.keys_raw.message}</p>
            )}
          </div>

          {/* Live preview + inline validation */}
          {selectedApp && preview.rows.length > 0 && (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
              <p className="font-medium text-gray-700 mb-1">
                Sẽ tạo {preview.rows.length} vai trò:
              </p>
              <ul className="space-y-0.5 max-h-32 overflow-auto">
                {preview.rows.map((r) => (
                  <li key={r.suffix} className="font-mono text-gray-600">
                    {selectedApp.slug}.{r.suffix}
                    {r.description && <span className="text-gray-400"> — {r.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.errors.length > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 space-y-0.5">
              {preview.errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {/* Parent role dropdown (applies to all) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Vai trò cha <span className="text-gray-400 font-normal">(tuỳ chọn — áp dụng cho tất cả)</span>
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

          {/* Per-row failures from server */}
          {serverErrors.length > 0 && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 space-y-0.5 max-h-40 overflow-auto">
              {serverErrors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Hủy
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? 'Đang tạo...' : `Tạo ${preview.rows.length || ''} vai trò`.trim()}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
