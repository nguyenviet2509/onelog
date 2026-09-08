/**
 * pages/apps/edit-app-page.tsx — Phase 09 Edit App page.
 *
 * Route: /apps/:slug/edit
 * Loads live OIDC config from Zitadel via GET /admin/apps/:slug/oidc-config (source of truth).
 * Editable: client_type, callback_urls, post_logout_urls.
 * Additional Origins auto-derived (read-only preview).
 *
 * Guards:
 *   - Public → confidential (spa/native → web): backend returns 400 with Vietnamese-safe error.
 *   - Client-type change: confirms via ConfirmDialog before submit.
 */
import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAppOidcConfigQuery, usePatchAppMutation } from '@/hooks/use-apps-query';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { ClientType } from '@/api/apps';

const CLIENT_TYPE_OPTIONS: Array<{
  value: ClientType;
  label: string;
  description: string;
}> = [
  {
    value: 'web',
    label: 'Web (confidential)',
    description: 'App backend server-side, có client_secret.',
  },
  {
    value: 'spa',
    label: 'SPA (public + PKCE)',
    description: 'App chạy trên trình duyệt. Không có client_secret.',
  },
  {
    value: 'native',
    label: 'Native (public + PKCE)',
    description: 'App mobile/desktop. Không có client_secret.',
  },
];

const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  web: 'Web (confidential)',
  spa: 'SPA (public + PKCE)',
  native: 'Native (public + PKCE)',
};

function deriveOrigins(urls: string[]): string[] {
  const origins = new Set<string>();
  for (const u of urls) {
    try {
      origins.add(new URL(u).origin);
    } catch {
      // ignore
    }
  }
  return [...origins];
}

export function EditAppPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data: config, isLoading, error, refetch } = useAppOidcConfigQuery(slug);
  const patch = usePatchAppMutation();

  const [clientType, setClientType] = useState<ClientType>('web');
  const [callbackUrls, setCallbackUrls] = useState('');
  const [postLogoutUrls, setPostLogoutUrls] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Prefill from server data
  useEffect(() => {
    if (config) {
      setClientType(config.client_type);
      setCallbackUrls(config.callback_urls.join('\n'));
      setPostLogoutUrls(config.post_logout_urls.join('\n'));
    }
  }, [config]);

  const callbackList = useMemo(
    () => callbackUrls.split(/\n+/).map((u) => u.trim()).filter(Boolean),
    [callbackUrls],
  );
  const postLogoutList = useMemo(
    () => postLogoutUrls.split(/\n+/).map((u) => u.trim()).filter(Boolean),
    [postLogoutUrls],
  );
  const originsPreview = useMemo(() => deriveOrigins(callbackList), [callbackList]);

  const clientTypeChanged = !!config && clientType !== config.client_type;

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (callbackList.length === 0) {
      errs['callback_urls'] = 'Cần ít nhất 1 callback URL';
    } else {
      for (const u of callbackList) {
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
    }
    for (const u of postLogoutList) {
      if (!u.startsWith('https://')) {
        errs['post_logout_urls'] = `Post Logout URI phải HTTPS: ${u}`;
        break;
      }
      try {
        new URL(u);
      } catch {
        errs['post_logout_urls'] = `Post Logout URI không hợp lệ: ${u}`;
        break;
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmitClick() {
    if (!validate() || !config) return;
    if (clientTypeChanged) {
      setConfirmOpen(true);
      return;
    }
    runPatch();
  }

  async function runPatch() {
    if (!slug || !config) return;
    setConfirmOpen(false);

    // Only send fields that actually changed (idempotent + smaller payload)
    const body: {
      client_type?: ClientType;
      callback_urls?: string[];
      post_logout_urls?: string[];
    } = {};
    if (clientType !== config.client_type) body.client_type = clientType;

    const cbChanged =
      callbackList.length !== config.callback_urls.length ||
      callbackList.some((u, i) => u !== config.callback_urls[i]);
    if (cbChanged) body.callback_urls = callbackList;

    const plChanged =
      postLogoutList.length !== config.post_logout_urls.length ||
      postLogoutList.some((u, i) => u !== config.post_logout_urls[i]);
    if (plChanged) body.post_logout_urls = postLogoutList;

    if (Object.keys(body).length === 0) {
      toastSuccess('Không có gì để lưu');
      return;
    }

    try {
      await patch.mutateAsync({ slug, body });
      toastSuccess(`Đã cập nhật app ${slug}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toastError(msg);
    }
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-gray-500">Đang tải cấu hình OIDC...</div>;
  }
  if (error) {
    return (
      <div className="p-6 space-y-3">
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md p-3">
          Lỗi tải config: {error instanceof Error ? error.message : String(error)}
        </div>
        <Button variant="outline" onClick={() => refetch()}>Thử lại</Button>
      </div>
    );
  }
  if (!config) {
    return <div className="p-6 text-sm text-gray-500">Không tìm thấy app.</div>;
  }

  const dbDriftWarning = config.client_type !== config.client_type_db;

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <Link to="/apps" className="text-sm text-blue-600 hover:underline">← Quay về danh sách</Link>
        <h1 className="text-2xl font-semibold text-gray-900 mt-1">
          Chỉnh sửa app: <span className="font-mono">{config.slug}</span>
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Cấu hình OIDC lấy trực tiếp từ Zitadel (source of truth).
        </p>
      </div>

      {dbDriftWarning && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-md p-3">
          <strong>Drift phát hiện:</strong> Central DB lưu <code>{config.client_type_db}</code> nhưng
          Zitadel đang là <code>{config.client_type}</code>. Save (không đổi type) để đồng bộ DB.
        </div>
      )}

      {/* Read-only metadata */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 uppercase">Thông tin (không sửa được)</h2>
        <ReadOnlyRow label="Tên" value={config.name} />
        <ReadOnlyRow label="Slug" value={config.slug} mono />
        <ReadOnlyRow label="Zitadel Project ID" value={config.zitadel_project_id} mono />
        {config.zitadel_client_id && (
          <ReadOnlyRow label="Client ID" value={config.zitadel_client_id} mono />
        )}
      </div>

      {/* Editable */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 uppercase">Cấu hình OIDC</h2>

        <FormField label="Loại client">
          <div className="space-y-2">
            {CLIENT_TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer transition ${
                  clientType === opt.value ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
                }`}
              >
                <input
                  type="radio"
                  name="client_type"
                  value={opt.value}
                  checked={clientType === opt.value}
                  onChange={() => setClientType(opt.value)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                    {opt.label}
                    {opt.value === config.client_type && (
                      <Badge variant="secondary" className="text-xs">hiện tại</Badge>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                </div>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Lưu ý: đổi từ SPA/Native (public) sang Web (confidential) hiện KHÔNG hỗ trợ (secret
            regeneration chưa có).
          </p>
        </FormField>

        <FormField label="Callback URLs (mỗi dòng 1 URL, HTTPS)" error={errors['callback_urls']}>
          <textarea
            value={callbackUrls}
            onChange={(e) => setCallbackUrls(e.target.value)}
            rows={3}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </FormField>

        <FormField
          label="Post Logout URIs (tùy chọn, mỗi dòng 1 URL, HTTPS)"
          error={errors['post_logout_urls']}
        >
          <textarea
            value={postLogoutUrls}
            onChange={(e) => setPostLogoutUrls(e.target.value)}
            rows={2}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </FormField>

        <FormField label="Additional Origins (auto)">
          <div className="border border-gray-200 rounded-md px-3 py-2 text-sm font-mono bg-gray-50 min-h-[38px] whitespace-pre-wrap text-gray-600">
            {originsPreview.length > 0 ? originsPreview.join('\n') : '(không có)'}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Tự động = origin của callback URLs. Zitadel cần để CORS SPA/PKCE work.
          </p>
        </FormField>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => navigate('/apps')}>Hủy</Button>
        <Button onClick={handleSubmitClick} disabled={patch.isPending}>
          {patch.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Xác nhận đổi loại client"
        description={`Đổi từ ${CLIENT_TYPE_LABEL[config.client_type]} sang ${CLIENT_TYPE_LABEL[clientType]}. Auth behavior của app sẽ thay đổi (PKCE vs client_secret). Tiếp tục?`}
        confirmLabel="Xác nhận đổi"
        onConfirm={runPatch}
        isLoading={patch.isPending}
      />
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

function ReadOnlyRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-1">
      <div className="text-sm text-gray-500">{props.label}</div>
      <div className={`col-span-2 text-sm ${props.mono ? 'font-mono text-xs' : ''}`}>{props.value}</div>
    </div>
  );
}
