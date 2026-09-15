/**
 * pages/apps/app-tokens-page.tsx — Per-app token management.
 *
 * List active + revoked tokens for an app. Create new (one-time reveal modal).
 * Revoke soft-deletes and invalidates in-memory cache backend-side.
 *
 * Backing API: /v1/admin/apps/:slug/tokens (Phase 3 plan 260915-0830).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  useAppTokensQuery,
  useCreateAppTokenMutation,
  useRevokeAppTokenMutation,
} from '@/hooks/use-app-tokens-query';
import type { AppToken, CreateTokenResult } from '@/api/apps';

export function AppTokensPage() {
  const { slug } = useParams<{ slug: string }>();
  const { data: tokens, isLoading, error } = useAppTokensQuery(slug);
  const createMut = useCreateAppTokenMutation(slug ?? '');
  const revokeMut = useRevokeAppTokenMutation(slug ?? '');

  const [createOpen, setCreateOpen] = useState(false);
  const [revealResult, setRevealResult] = useState<CreateTokenResult | null>(null);

  async function handleCreate(label: string) {
    const result = await createMut.mutateAsync(label);
    setCreateOpen(false);
    setRevealResult(result);
  }

  async function handleRevoke(t: AppToken) {
    if (!confirm(`Revoke token "${t.label}" (${t.prefix})? This cannot be undone.`)) return;
    await revokeMut.mutateAsync(t.id);
  }

  if (!slug) return <div className="p-6">Missing slug.</div>;

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Link to="/apps" className="text-sm text-blue-600 hover:underline">
            ← Apps
          </Link>
          <h1 className="text-2xl font-semibold mt-1">
            Tokens: <code className="bg-gray-100 px-2 py-0.5 rounded text-lg">{slug}</code>
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Per-app tokens (X-Rbac-Token) for SDK calls to /v2/resolve + /v2/epoch. Multi-token per
            app — use labels like <code>prod</code>, <code>staging</code>, <code>dev-alice</code>.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>+ Create token</Button>
      </div>

      {isLoading && <div className="text-gray-500 text-sm">Loading tokens…</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded p-3">
          Failed to load tokens: {String(error)}
        </div>
      )}

      {tokens && (
        <div className="border border-gray-200 rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-xs text-gray-600 uppercase">
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">Prefix</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                    No tokens yet. Click <strong>+ Create token</strong> to add one.
                  </td>
                </tr>
              )}
              {tokens.map((t) => (
                <tr key={t.id} className={`border-b border-gray-100 ${t.revoked_at ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-2 font-medium">{t.label}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700">
                    rbac_{t.prefix}_…
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {new Date(t.created_at).toLocaleString()}
                    <div className="text-gray-400">by {t.created_by}</div>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {t.revoked_at ? (
                      <Badge variant="destructive">revoked</Badge>
                    ) : (
                      <Badge>active</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!t.revoked_at && (
                      <Button size="sm" variant="outline" onClick={() => handleRevoke(t)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateTokenModal
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
          submitting={createMut.isPending}
        />
      )}
      {revealResult && (
        <RevealTokenModal token={revealResult} onClose={() => setRevealResult(null)} />
      )}
    </div>
  );
}

function CreateTokenModal({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (label: string) => void;
  submitting: boolean;
}) {
  const [label, setLabel] = useState('');
  const valid = /^[a-z0-9-]{2,32}$/.test(label);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" title="Create token">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="prod, staging, dev-alice"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Lowercase alphanumeric + dash. 2-32 chars. Must be unique per app (among active tokens).
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => onSubmit(label)} disabled={!valid || submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RevealTokenModal({ token, onClose }: { token: CreateTokenResult; onClose: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && acknowledged && onClose()}>
      <DialogContent className="max-w-lg" title="🔐 Token created — shown once">
        <div className="space-y-4">
          <div className="bg-red-50 border border-red-200 text-red-900 text-sm rounded-md p-3">
            {token.warning}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Label: <code className="bg-gray-100 px-1 rounded">{token.label}</code>
            </label>
            <div className="flex gap-2">
              <div className="flex-1 border border-gray-300 rounded px-3 py-2 font-mono text-xs bg-gray-50 min-h-[38px] flex items-center overflow-x-auto">
                {revealed ? token.token : '••••••••••••••••••••••••••••••••••••••••'}
              </div>
              <Button size="sm" variant="outline" onClick={() => setRevealed((v) => !v)}>
                {revealed ? 'Hide' : 'Show'}
              </Button>
              <Button size="sm" variant="outline" onClick={copy}>
                {copied ? '✓' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Set as <code className="bg-gray-100 px-1 rounded">CENTRAL_RBAC_TOKEN</code> in your app{' '}
              <code className="bg-gray-100 px-1 rounded">.env</code>. Beware of clipboard history managers.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700 pt-2 border-t border-gray-100">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>I've copied the token and understand it cannot be retrieved again.</span>
          </label>

          <div className="flex justify-end">
            <Button onClick={onClose} disabled={!acknowledged}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
