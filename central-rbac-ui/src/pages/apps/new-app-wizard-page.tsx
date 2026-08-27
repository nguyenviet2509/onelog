/**
 * pages/apps/new-app-wizard-page.tsx — Phase 07 admin wizard.
 * Hybrid wizard per plan validation:
 *   Step 1: name, slug, callback URLs, manifest_url (optional)
 *   Step 2: preview + confirm
 *   Success: one-time reveal of client_id + client_secret
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCreateAppMutation } from '@/hooks/use-apps-query';
import { ClientSecretRevealDialog } from './client-secret-reveal-dialog';
import type { CreateAppResult } from '@/api/apps';

const SLUG_REGEX = /^[a-z][a-z0-9-]{2,31}$/;

interface FormState {
  name: string;
  slug: string;
  callback_urls: string;   // newline-separated in form; split on submit
  manifest_url: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function NewAppWizardPage() {
  const navigate = useNavigate();
  const createApp = useCreateAppMutation();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<FormState>({
    name: '',
    slug: '',
    callback_urls: '',
    manifest_url: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<CreateAppResult | null>(null);

  function validateStep1(): boolean {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs['name'] = 'Tên không được để trống';
    if (!SLUG_REGEX.test(form.slug)) errs['slug'] = 'Slug phải khớp ^[a-z][a-z0-9-]{2,31}$';
    const urls = form.callback_urls.split(/\n+/).map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) errs['callback_urls'] = 'Cần ít nhất 1 callback URL';
    for (const u of urls) {
      if (!u.startsWith('https://')) {
        errs['callback_urls'] = `Callback URL phải HTTPS: ${u}`;
        break;
      }
      try {
        new URL(u);
      } catch {
        errs['callback_urls'] = `Callback URL không hợp lệ: ${u}`;
        break;
      }
    }
    if (form.manifest_url && !form.manifest_url.startsWith('https://')) {
      errs['manifest_url'] = 'Manifest URL phải HTTPS';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleNext() {
    if (validateStep1()) setStep(2);
  }

  async function handleConfirm() {
    const callback_urls = form.callback_urls.split(/\n+/).map((u) => u.trim()).filter(Boolean);
    try {
      const result = await createApp.mutateAsync({
        name: form.name.trim(),
        slug: form.slug,
        callback_urls,
        ...(form.manifest_url ? { manifest_url: form.manifest_url } : {}),
      });
      setReveal(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrors({ submit: msg });
      setStep(1);
    }
  }

  function handleRevealClose() {
    setReveal(null);
    navigate('/apps');
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">App mới</h1>
        <p className="text-sm text-gray-500 mt-1">
          Bước {step}/2 — {step === 1 ? 'thông tin app' : 'xem lại + xác nhận'}
        </p>
      </div>

      {errors['submit'] && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md p-3">
          {errors['submit']}
        </div>
      )}

      {step === 1 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <FormField label="Tên hiển thị" error={errors['name']}>
            <Input
              value={form.name}
              onChange={(e) => {
                const name = e.target.value;
                setForm((f) => ({ ...f, name, slug: f.slug || slugify(name) }));
              }}
              placeholder="Ví dụ: Portal Đơn Hàng"
            />
          </FormField>

          <FormField label="Slug (kebab-case, immutable)" error={errors['slug']}>
            <Input
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
              placeholder="portal-donhang"
              className="font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              Format: ^[a-z][a-z0-9-]{'{2,31}'}$. Bắt đầu bằng chữ, 3-32 ký tự.
            </p>
          </FormField>

          <FormField label="Callback URLs (mỗi dòng 1 URL, HTTPS)" error={errors['callback_urls']}>
            <textarea
              value={form.callback_urls}
              onChange={(e) => setForm((f) => ({ ...f, callback_urls: e.target.value }))}
              placeholder="https://portal.example.com/callback&#10;https://portal.example.com/silent-callback"
              rows={3}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </FormField>

          <FormField label="Manifest URL (tùy chọn, HTTPS)" error={errors['manifest_url']}>
            <Input
              value={form.manifest_url}
              onChange={(e) => setForm((f) => ({ ...f, manifest_url: e.target.value }))}
              placeholder="https://portal.example.com/.well-known/rbac-permissions.json"
              className="font-mono text-xs"
            />
            <p className="text-xs text-gray-500 mt-1">
              App có thể tự đăng ký permissions qua manifest sau. Bỏ trống nếu chưa sẵn sàng.
            </p>
          </FormField>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => navigate('/apps')}>
              Hủy
            </Button>
            <Button onClick={handleNext}>Tiếp →</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Xem lại</h2>
          <ReviewRow label="Tên" value={form.name} />
          <ReviewRow label="Slug" value={form.slug} mono />
          <ReviewRow label="Callback URLs" value={form.callback_urls} mono multiline />
          <ReviewRow label="Manifest URL" value={form.manifest_url || '(để trống)'} mono />
          <ReviewRow
            label="Default roles (auto-tạo)"
            value={`${form.slug}.viewer, ${form.slug}.editor, ${form.slug}.admin`}
            mono
          />

          <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-md p-3">
            <strong>Cảnh báo:</strong> Zitadel sẽ tạo project + OIDC client. Client secret chỉ hiển thị 1 lần.
            Lưu ngay khi thấy — không thể lấy lại.
          </div>

          <div className="flex justify-between pt-4">
            <Button variant="ghost" onClick={() => setStep(1)}>
              ← Sửa
            </Button>
            <Button onClick={handleConfirm} disabled={createApp.isPending}>
              {createApp.isPending ? 'Đang tạo...' : 'Xác nhận + Tạo'}
            </Button>
          </div>
        </div>
      )}

      {reveal && (
        <ClientSecretRevealDialog result={reveal} onClose={handleRevealClose} />
      )}
    </div>
  );
}

function FormField(props: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{props.label}</label>
      {props.children}
      {props.error && <p className="text-xs text-red-600 mt-1">{props.error}</p>}
    </div>
  );
}

function ReviewRow(props: { label: string; value: string; mono?: boolean; multiline?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-2 border-b border-gray-100 last:border-b-0">
      <div className="text-sm text-gray-500">{props.label}</div>
      <div
        className={`col-span-2 text-sm ${props.mono ? 'font-mono text-xs' : ''} ${
          props.multiline ? 'whitespace-pre-wrap' : ''
        }`}
      >
        {props.value}
      </div>
    </div>
  );
}
