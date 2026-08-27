/**
 * pages/apps/manifest-sync-page.tsx — Phase 08 manifest sync + diff review UI.
 *
 * Fix #9: 4-category diff. Implicit-deprecate default UNCHECKED + warning banner.
 * Fix #14: sha256-pinned apply (client sends manifest_sha256 with approved_items).
 */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useAppsQuery,
  useApplyManifestDiffMutation,
  useSyncManifestMutation,
} from '@/hooks/use-apps-query';
import type { DiffAction, DiffItem, SyncResult } from '@/api/apps';

const CATEGORIES: {
  key: DiffAction;
  label: string;
  color: string;
  defaultChecked: boolean;
  warning?: string;
}[] = [
  { key: 'add', label: 'Thêm mới', color: 'text-green-800 bg-green-50 border-green-200', defaultChecked: true },
  { key: 'update-desc', label: 'Cập nhật mô tả', color: 'text-blue-800 bg-blue-50 border-blue-200', defaultChecked: true },
  {
    key: 'explicit-deprecate',
    label: 'Deprecate (khai báo)',
    color: 'text-orange-800 bg-orange-50 border-orange-200',
    defaultChecked: true,
  },
  {
    key: 'implicit-deprecate',
    label: 'Deprecate (mất khỏi manifest)',
    color: 'text-red-800 bg-red-50 border-red-200',
    defaultChecked: false,
    warning:
      'Permission có trong DB nhưng manifest mới không khai báo — có thể do app team quên/typo. UNCHECKED mặc định để phòng ngừa.',
  },
];

export function ManifestSyncPage() {
  const { id } = useParams<{ id: string }>();
  const { data: apps = [] } = useAppsQuery();
  const app = apps.find((a) => a.id === id);
  const syncMutation = useSyncManifestMutation(id ?? '');
  const applyMutation = useApplyManifestDiffMutation(id ?? '');
  const [result, setResult] = useState<SyncResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyResult, setApplyResult] = useState<{ counts: Record<DiffAction, number> } | null>(null);

  async function handleSync() {
    setResult(null);
    setApplyResult(null);
    try {
      const r = await syncMutation.mutateAsync();
      setResult(r);
      // Initialize checkbox state based on category defaults
      if (r.status === 'fetched' && r.diff) {
        const next = new Set<string>();
        for (const item of r.diff.items) {
          const cat = CATEGORIES.find((c) => c.key === item.action);
          if (cat?.defaultChecked) next.add(`${item.action}:${item.id}`);
        }
        setSelected(next);
      }
    } catch (err) {
      setResult(null);
      alert(`Sync thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function toggle(item: DiffItem) {
    const key = `${item.action}:${item.id}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleCategory(cat: DiffAction, on: boolean) {
    if (!result?.diff) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of result.diff!.items) {
        if (item.action !== cat) continue;
        const k = `${item.action}:${item.id}`;
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  async function handleApply() {
    if (!result?.diff || !result.manifest_sha256) return;
    const approved_items = [...selected].map((s) => {
      const idx = s.indexOf(':');
      return { action: s.slice(0, idx) as DiffAction, id: s.slice(idx + 1) };
    });
    try {
      const r = await applyMutation.mutateAsync({
        manifest_sha256: result.manifest_sha256,
        approved_items,
      });
      setApplyResult({ counts: r.applied_counts });
    } catch (err) {
      alert(`Apply thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!app) {
    return (
      <div className="max-w-4xl mx-auto">
        <p className="text-sm text-gray-500">Không tìm thấy app.</p>
        <Link to="/apps" className="text-blue-600 text-sm hover:underline">← Quay lại danh sách</Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <Link to="/apps" className="text-blue-600 text-sm hover:underline">← Ứng dụng</Link>
        <h1 className="text-2xl font-semibold text-gray-900 mt-2">Sync Manifest — {app.name}</h1>
        <p className="text-sm text-gray-500 mt-1 font-mono">{app.manifest_url ?? '(chưa cấu hình manifest_url)'}</p>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSync} disabled={syncMutation.isPending || !app.manifest_url}>
          {syncMutation.isPending ? 'Đang fetch...' : 'Fetch + Diff'}
        </Button>
      </div>

      {result?.status === 'not-modified' && (
        <div className="bg-blue-50 border border-blue-200 text-blue-900 text-sm rounded-md p-3">
          Manifest không thay đổi (ETag khớp). Không cần apply.
        </div>
      )}

      {result?.status === 'fetched' && result.diff && (
        <div className="space-y-3">
          <div className="bg-white border border-gray-200 rounded-md p-3 text-sm">
            <div className="grid grid-cols-4 gap-3">
              {CATEGORIES.map((c) => (
                <div key={c.key} className={`rounded p-2 border ${c.color}`}>
                  <div className="text-xs font-medium">{c.label}</div>
                  <div className="text-2xl font-bold">{result.diff!.counts[c.key]}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs text-gray-500 font-mono">
            SHA256: {result.manifest_sha256} · Service: {result.service} · Version: {result.version}
          </div>

          {CATEGORIES.map((cat) => {
            const items = result.diff!.items.filter((it) => it.action === cat.key);
            if (items.length === 0) return null;
            return (
              <div key={cat.key} className={`rounded-md border ${cat.color} overflow-hidden`}>
                <div className="flex items-center justify-between px-3 py-2 bg-white/30">
                  <div>
                    <strong>{cat.label}</strong> <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  <div className="text-xs">
                    <button
                      className="mr-2 underline"
                      onClick={() => toggleCategory(cat.key, true)}
                    >
                      Chọn hết
                    </button>
                    <button className="underline" onClick={() => toggleCategory(cat.key, false)}>
                      Bỏ hết
                    </button>
                  </div>
                </div>
                {cat.warning && (
                  <div className="px-3 py-2 text-xs bg-white/60 border-t border-b border-current/20">
                    ⚠️ {cat.warning}
                  </div>
                )}
                <div className="bg-white">
                  {items.map((item) => (
                    <label
                      key={`${item.action}:${item.id}`}
                      className="flex items-start gap-3 px-3 py-2 border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selected.has(`${item.action}:${item.id}`)}
                        onChange={() => toggle(item)}
                      />
                      <div className="flex-1">
                        <div className="font-mono text-xs text-gray-900">{item.id}</div>
                        {item.incoming?.description && (
                          <div className="text-xs text-gray-600 mt-0.5">→ {item.incoming.description}</div>
                        )}
                        {item.current?.description && item.action !== 'add' && (
                          <div className="text-xs text-gray-400 mt-0.5 line-through">{item.current.description}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="flex justify-end pt-2">
            <Button onClick={handleApply} disabled={applyMutation.isPending || selected.size === 0}>
              {applyMutation.isPending ? 'Đang apply...' : `Apply ${selected.size} thay đổi`}
            </Button>
          </div>

          {applyResult && (
            <div className="bg-green-50 border border-green-200 text-green-900 text-sm rounded-md p-3">
              <strong>Đã apply:</strong>{' '}
              add {applyResult.counts.add} · update-desc {applyResult.counts['update-desc']} ·
              explicit-deprecate {applyResult.counts['explicit-deprecate']} ·
              implicit-deprecate {applyResult.counts['implicit-deprecate']}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
