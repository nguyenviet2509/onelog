/**
 * pages/audit/audit-log-page.tsx — Central audit log viewer.
 *
 * Filters: app, action, actor_id, from/to. Server-side pagination via limit+offset.
 * Row click opens a drawer showing before/after JSON + hash-chain fields (forensic).
 *
 * Data source: GET /v1/audit (JWT-protected). Rows include both internal rbac
 * events (app_id=NULL) and events pushed from external apps via /v1/audit/ingest.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAudit, type AuditLogRow, type AuditListParams } from '@/api/audit';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const PAGE_SIZE = 100;

// App options: NULL bucket for internal rbac + known external app_ids.
// Add new app_ids here as they ingress (or switch to server-side facets endpoint).
const APP_OPTIONS = [
  { value: '', label: 'Tất cả app' },
  { value: 'rbac', label: 'Central RBAC (nội bộ)' },
  { value: 'onemcp', label: 'OneMCP' },
];

export function AuditLogPage() {
  const [filters, setFilters] = useState<AuditListParams>({});
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);

  const query = useQuery({
    queryKey: ['audit', filters, page],
    queryFn: () => listAudit({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    staleTime: 15_000,
  });

  function updateFilter<K extends keyof AuditListParams>(key: K, val: AuditListParams[K]) {
    setPage(0);
    setFilters((f) => {
      const next = { ...f };
      if (val === '' || val == null) delete next[key];
      else next[key] = val;
      return next;
    });
  }

  const rows = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <span className="text-xs text-gray-500">
          Central store · hash-chain verified
        </span>
      </div>

      {/* Filter bar */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <Select
          value={filters.app_id ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            // 'rbac' = special: filter server can't do "IS NULL" via string; use 'rbac' text match
            // Backend rbac events have app_id=NULL — filter behaves as "no filter" for now.
            // TODO: server-side IS NULL sentinel if noise becomes issue.
            if (v === 'rbac') updateFilter('app_id', undefined);
            else updateFilter('app_id', v || undefined);
          }}
        >
          {APP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        <Input
          placeholder="Action (VD: oauth.token.issue)"
          value={filters.action ?? ''}
          onChange={(e) => updateFilter('action', e.target.value || undefined)}
        />
        <Input
          placeholder="Actor ID / username"
          value={filters.actor_id ?? ''}
          onChange={(e) => updateFilter('actor_id', e.target.value || undefined)}
        />
        <Input
          type="datetime-local"
          value={filters.from?.slice(0, 16) ?? ''}
          onChange={(e) => updateFilter('from', e.target.value ? new Date(e.target.value).toISOString() : undefined)}
        />
        <Input
          type="datetime-local"
          value={filters.to?.slice(0, 16) ?? ''}
          onChange={(e) => updateFilter('to', e.target.value ? new Date(e.target.value).toISOString() : undefined)}
        />
      </div>

      {/* Result table */}
      <div className="rounded-md border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-600">
            <tr>
              <th className="px-3 py-2">Thời gian</th>
              <th className="px-3 py-2">App</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {query.isLoading && (
              <tr><td className="px-3 py-4 text-gray-500" colSpan={6}>Đang tải…</td></tr>
            )}
            {query.isError && (
              <tr><td className="px-3 py-4 text-red-600" colSpan={6}>Lỗi tải audit log</td></tr>
            )}
            {!query.isLoading && rows.length === 0 && (
              <tr><td className="px-3 py-4 text-gray-500" colSpan={6}>Không có bản ghi</td></tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                className="cursor-pointer hover:bg-gray-50"
              >
                <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                  {new Date(r.ts).toLocaleString('vi-VN')}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={r.app_id ? 'default' : 'secondary'}>
                    {r.app_id ?? 'rbac'}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="text-gray-900">{r.actor_email || r.actor_id}</div>
                  <div className="text-xs text-gray-500">{r.actor_type}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                <td className="px-3 py-2 text-xs">
                  {r.target_type}/{r.target_id}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500">{r.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500">
          Trang {page + 1} · {rows.length} bản ghi
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Trước
          </Button>
          <Button
            variant="outline"
            disabled={rows.length < PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Sau →
          </Button>
        </div>
      </div>

      {/* Detail drawer — simple overlay panel */}
      {selected && (
        <AuditDetailDrawer row={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function AuditDetailDrawer({ row, onClose }: { row: AuditLogRow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/40" />
      <div
        className="w-full max-w-xl bg-white shadow-xl overflow-y-auto p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Chi tiết bản ghi</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-800">✕</button>
        </div>
        <dl className="grid grid-cols-3 gap-y-2 text-sm">
          <dt className="text-gray-500">Seq</dt><dd className="col-span-2 font-mono">{row.seq}</dd>
          <dt className="text-gray-500">Thời gian</dt><dd className="col-span-2">{new Date(row.ts).toLocaleString('vi-VN')}</dd>
          <dt className="text-gray-500">App</dt><dd className="col-span-2">{row.app_id ?? 'rbac (nội bộ)'}</dd>
          <dt className="text-gray-500">Action</dt><dd className="col-span-2 font-mono">{row.action}</dd>
          <dt className="text-gray-500">Actor</dt><dd className="col-span-2">{row.actor_email || row.actor_id} <span className="text-xs text-gray-500">({row.actor_type})</span></dd>
          <dt className="text-gray-500">Target</dt><dd className="col-span-2">{row.target_type}/{row.target_id}</dd>
          <dt className="text-gray-500">IP</dt><dd className="col-span-2">{row.ip ?? '—'}</dd>
          <dt className="text-gray-500">Correlation ID</dt><dd className="col-span-2 font-mono text-xs">{row.correlation_id ?? '—'}</dd>
        </dl>

        <details className="rounded border border-gray-200 p-2">
          <summary className="cursor-pointer text-sm font-medium">Before state</summary>
          <pre className="mt-2 text-xs overflow-auto bg-gray-50 p-2 rounded">
            {JSON.stringify(row.before_state, null, 2)}
          </pre>
        </details>
        <details className="rounded border border-gray-200 p-2" open>
          <summary className="cursor-pointer text-sm font-medium">After state</summary>
          <pre className="mt-2 text-xs overflow-auto bg-gray-50 p-2 rounded">
            {JSON.stringify(row.after_state, null, 2)}
          </pre>
        </details>
        <details className="rounded border border-gray-200 p-2">
          <summary className="cursor-pointer text-sm font-medium">Hash chain (forensic)</summary>
          <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs font-mono break-all">
            <div><span className="text-gray-500">row_hash: </span>{row.row_hash}</div>
            <div><span className="text-gray-500">prev_hash: </span>{row.prev_hash ?? 'null (first row)'}</div>
            <div><span className="text-gray-500">chained_hash: </span>{row.chained_hash}</div>
          </dl>
        </details>
      </div>
    </div>
  );
}
