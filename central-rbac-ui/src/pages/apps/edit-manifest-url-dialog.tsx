/**
 * pages/apps/edit-manifest-url-dialog.tsx — Update app.manifest_url after creation.
 * Phase 07 Fix #15: allow admin to fix/update URL post-wizard.
 */
import { useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUpdateManifestUrlMutation } from '@/hooks/use-apps-query';
import type { App } from '@/api/apps';

export function EditManifestUrlDialog({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState(app.manifest_url ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useUpdateManifestUrlMutation();

  async function handleSave() {
    setError(null);
    if (!url.startsWith('https://')) {
      setError('URL phải HTTPS');
      return;
    }
    try {
      await mutation.mutateAsync({ appId: app.id, manifestUrl: url });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Sửa Manifest URL — ${app.name}`}>
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            Manifest URL (HTTPS, public DNS)
          </label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://app.example.com/.well-known/rbac-permissions.json"
            className="font-mono text-xs"
          />
          <p className="text-xs text-gray-500">
            App cần expose file JSON tại URL này theo schema{' '}
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">/.well-known/rbac-permissions-schema.json</code>.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? 'Đang lưu...' : 'Lưu'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
