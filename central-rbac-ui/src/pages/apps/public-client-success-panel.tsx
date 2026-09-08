/**
 * pages/apps/public-client-success-panel.tsx — success reveal for public (PKCE) clients.
 *
 * Shown after wizard creates a spa/native app. No client_secret to reveal — just
 * project_id + client_id + note explaining PKCE flow. Mirrors the shape of
 * ClientSecretRevealDialog for confidential apps.
 */
import { useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { CreateAppResult, ClientType } from '@/api/apps';

const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  web: 'Web (confidential)',
  spa: 'SPA (public + PKCE)',
  native: 'Native (public + PKCE)',
};

export function PublicClientSuccessPanel({
  result,
  onClose,
}: {
  result: CreateAppResult;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'client_id' | 'project_id' | null>(null);

  async function copy(text: string, which: 'client_id' | 'project_id') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" title="✓ Public client đã tạo (PKCE)">
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 text-green-900 text-sm rounded-md p-3">
            App <strong>{result.name}</strong> đã tạo dưới dạng{' '}
            <strong>{CLIENT_TYPE_LABEL[result.client_type]}</strong>.
            {' '}Public client dùng PKCE flow — <strong>không có client_secret</strong>.
            {result.note && <div className="mt-2 text-xs text-green-800">{result.note}</div>}
          </div>

          <Field
            label="Client ID"
            value={result.client_id}
            onCopy={() => copy(result.client_id, 'client_id')}
            copied={copied === 'client_id'}
          />

          <Field
            label="Zitadel Project ID"
            value={result.zitadel_project_id}
            onCopy={() => copy(result.zitadel_project_id, 'project_id')}
            copied={copied === 'project_id'}
          />

          <div className="bg-blue-50 border border-blue-200 text-blue-900 text-xs rounded-md p-3 space-y-1">
            <div><strong>PKCE flow:</strong> SPA/Native gọi Zitadel bằng <code>response_type=code</code>{' '}
              + <code>code_challenge</code>/<code>code_verifier</code>. Không lưu secret ở client side.</div>
            <div>
              Verify config trong Zitadel Console tại{' '}
              <a
                href="https://zitadel.000nethost.com"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                zitadel.000nethost.com
              </a>
              {' '}(Projects → {result.name} → Applications).
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4 mt-4 border-t border-gray-100">
          <Button onClick={onClose}>Đóng</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex gap-2">
        <div className="flex-1 border border-gray-300 rounded-md px-3 py-2 font-mono text-xs bg-gray-50 min-h-[38px] flex items-center overflow-x-auto">
          {value}
        </div>
        <Button size="sm" variant="outline" onClick={onCopy}>
          {copied ? '✓' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
