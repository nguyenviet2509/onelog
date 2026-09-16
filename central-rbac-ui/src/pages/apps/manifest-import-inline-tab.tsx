/**
 * manifest-import-inline-tab.tsx — Phase 3 plan 260915-1615.
 *
 * Split panel:
 *   Left  = format toggle (JSON/YAML) + textarea content (mono, 25 rows)
 *   Right = live preview parse result (debounced 300ms):
 *             - Red banner  → parse fail with error message
 *             - Green banner + parsed JSON → OK, ready to sync
 *
 * Submit button disabled khi parse fail hoặc content trống.
 * On submit → POST /v1/admin/apps/:id/sync-manifest-inline → parent onResult(SyncResult).
 *
 * No lock textarea after preview — user edit anytime, live re-parse.
 * js-yaml browser build (~4KB gzip) — same version backend (4.1.0 pinned).
 */
import { useEffect, useMemo, useState } from 'react';
import yaml from 'js-yaml';
import { Button } from '@/components/ui/button';
import { useSyncManifestInlineMutation } from '@/hooks/use-apps-query';
import type { SyncResult } from '@/api/apps';

type Format = 'json' | 'yaml';

interface ParseState {
  status: 'empty' | 'ok' | 'error';
  parsed?: unknown;
  error?: string;
}

interface Props {
  appId: string;
  onResult: (result: SyncResult) => void;
}

/** js-yaml browser dùng CORE_SCHEMA — safe (no custom tags, no code exec). Same as backend. */
function parseContent(format: Format, raw: string): ParseState {
  if (!raw.trim()) return { status: 'empty' };
  try {
    const parsed =
      format === 'yaml'
        ? yaml.load(raw, { schema: yaml.CORE_SCHEMA })
        : JSON.parse(raw);
    return { status: 'ok', parsed };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function ManifestImportInlineTab({ appId, onResult }: Props) {
  const [format, setFormat] = useState<Format>('yaml');
  const [content, setContent] = useState('');
  const [debounced, setDebounced] = useState('');
  const mutation = useSyncManifestInlineMutation(appId);

  // Debounce 300ms để tránh re-parse mỗi keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebounced(content), 300);
    return () => clearTimeout(t);
  }, [content]);

  const parseState = useMemo(() => parseContent(format, debounced), [format, debounced]);

  async function handleSubmit() {
    if (parseState.status !== 'ok') return;
    try {
      const result = await mutation.mutateAsync({ format, content });
      onResult(result);
    } catch (err) {
      alert(
        `Sync inline thất bại: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const submitDisabled = parseState.status !== 'ok' || mutation.isPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium text-gray-700">Format:</span>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="radio"
            name="format"
            value="yaml"
            checked={format === 'yaml'}
            onChange={() => setFormat('yaml')}
          />
          <span>YAML</span>
        </label>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="radio"
            name="format"
            value="json"
            checked={format === 'json'}
            onChange={() => setFormat('json')}
          />
          <span>JSON</span>
        </label>
        <span className="ml-auto text-xs text-gray-500">
          Cap 100KB · YAML safe schema (no custom tags)
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Left — textarea input */}
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">
            Nội dung {format.toUpperCase()}
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={25}
            className="w-full font-mono text-xs border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={
              format === 'yaml'
                ? `schema: '2'\nservice: my-app\nversion: '1.0.0'\npermissions:\n  - id: my-app:read\n    description: Read\n...`
                : `{\n  "schema": "2",\n  "service": "my-app",\n  ...\n}`
            }
            spellCheck={false}
          />
          <div className="text-xs text-gray-500 mt-1">
            {content.length.toLocaleString()} ký tự
            {content.length > 100 * 1024 && (
              <span className="text-red-600 ml-2">⚠ vượt 100KB cap</span>
            )}
          </div>
        </div>

        {/* Right — live preview */}
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Preview</div>
          <div className="border border-gray-300 rounded-md h-[calc(25*1.5em+1rem)] overflow-auto">
            {parseState.status === 'empty' && (
              <div className="p-3 text-xs text-gray-500 italic">
                Paste manifest vào ô bên trái để xem preview…
              </div>
            )}
            {parseState.status === 'error' && (
              <div className="p-3">
                <div className="bg-red-50 border border-red-200 text-red-900 text-xs rounded-md p-2 mb-2">
                  <strong>❌ Parse {format.toUpperCase()} lỗi:</strong>
                </div>
                <pre className="text-xs text-red-800 font-mono whitespace-pre-wrap">
                  {parseState.error}
                </pre>
              </div>
            )}
            {parseState.status === 'ok' && (
              <div className="p-3">
                <div className="bg-green-50 border border-green-200 text-green-900 text-xs rounded-md p-2 mb-2">
                  <strong>✅ Parse OK</strong> — Preview parsed JSON:
                </div>
                <pre className="text-xs text-gray-800 font-mono whitespace-pre">
                  {JSON.stringify(parseState.parsed, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <div className="text-xs text-gray-500">
          Server side validate schema v1/v2 (namespace, hierarchy, delegation) khi
          submit. Parse error hiển thị inline; schema error trả về sau khi bấm Sync.
        </div>
        <Button onClick={handleSubmit} disabled={submitDisabled}>
          {mutation.isPending ? 'Đang sync…' : 'Sync từ inline'}
        </Button>
      </div>
    </div>
  );
}
