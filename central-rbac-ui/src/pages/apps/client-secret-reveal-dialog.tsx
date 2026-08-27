/**
 * pages/apps/client-secret-reveal-dialog.tsx — ONE-TIME reveal of client_secret.
 * Fix #S8 hardening: no auto-clipboard (clipboard history managers persist), hover-to-reveal.
 * Cache-Control on response is set backend-side.
 */
import { useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { CreateAppResult } from '@/api/apps';

export function ClientSecretRevealDialog({
  result,
  onClose,
}: {
  result: CreateAppResult;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<'id' | 'secret' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function copyToClipboard(text: string, which: 'id' | 'secret') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && acknowledged && onClose()}>
      <DialogContent className="max-w-lg" title="🔐 Client secret — chỉ hiển thị 1 lần">
        <div className="space-y-4">
          <div className="bg-red-50 border border-red-200 text-red-900 text-sm rounded-md p-3">
            App <strong>{result.name}</strong> đã tạo. Copy client_id + client_secret NGAY và lưu vào Bitwarden.
            Sau khi đóng dialog này, secret không thể xem lại.
          </div>

          <Field label="Client ID" value={result.client_id} onCopy={() => copyToClipboard(result.client_id, 'id')} copied={copied === 'id'} />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client Secret</label>
            <div className="flex gap-2">
              <div className="flex-1 border border-gray-300 rounded-md px-3 py-2 font-mono text-xs bg-gray-50 min-h-[38px] flex items-center overflow-x-auto">
                {revealed ? result.client_secret : '••••••••••••••••••••••••••••••••••••••••'}
              </div>
              <Button size="sm" variant="outline" onClick={() => setRevealed((v) => !v)}>
                {revealed ? 'Ẩn' : 'Hiện'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(result.client_secret, 'secret')}
              >
                {copied === 'secret' ? '✓' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              ⚠️ Cẩn thận với clipboard history managers (Windows clipboard, macOS universal clipboard).
              Xoá clipboard sau khi paste vào Bitwarden.
            </p>
          </div>

          <Field label="Zitadel Project ID" value={result.zitadel_project_id} onCopy={() => copyToClipboard(result.zitadel_project_id, 'id')} copied={false} />

          <label className="flex items-start gap-2 text-sm text-gray-700 pt-2 border-t border-gray-100">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>Tôi đã lưu client_secret + hiểu rằng không thể xem lại.</span>
          </label>
        </div>

        <div className="flex justify-end pt-4 mt-4 border-t border-gray-100">
          <Button onClick={onClose} disabled={!acknowledged}>
            Đóng
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onCopy, copied }: { label: string; value: string; onCopy: () => void; copied: boolean }) {
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
