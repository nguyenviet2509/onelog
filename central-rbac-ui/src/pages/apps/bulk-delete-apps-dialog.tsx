/**
 * pages/apps/bulk-delete-apps-dialog.tsx — Bulk delete registered apps.
 * Removes Zitadel project + rbac.apps row per item. Type-verify "XOA".
 */
import { useState, useEffect } from 'react';
import axios from 'axios';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useBulkDelete, type BulkDeleteResult } from '@/hooks/use-bulk-delete';
import { deleteApp, type App } from '@/api/apps';
import { useQueryClient } from '@tanstack/react-query';
import { toastSuccess, toastError } from '@/lib/toast-bus';
import type { ApiError } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedApps: App[];
  onDone?: () => void;
}

const CONFIRM_TOKEN = 'XOA';

export function BulkDeleteAppsDialog({ open, onOpenChange, selectedApps, onDone }: Props) {
  const [confirmInput, setConfirmInput] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [finalResults, setFinalResults] = useState<BulkDeleteResult[]>([]);
  const qc = useQueryClient();

  const { run, abort, isRunning } = useBulkDelete(async (id) => {
    try {
      await deleteApp(id);
    } catch (e) {
      if (axios.isAxiosError<ApiError>(e)) {
        throw new Error(e.response?.data?.error ?? e.message);
      }
      throw e;
    }
  });

  useEffect(() => {
    if (!open) abort();
    return () => abort();
  }, [open, abort]);

  async function handleSubmit() {
    if (confirmInput !== CONFIRM_TOKEN || selectedApps.length === 0) return;
    const items = selectedApps
      .filter((a): a is App & { id: string; slug: string } => !!a.id && !!a.slug)
      .map((a) => ({ id: a.id, label: a.slug }));
    const results = await run(items);
    setFinalResults(results);
    setShowResults(true);
    void qc.invalidateQueries({ queryKey: ['apps'] });
    const okCount = results.filter((r) => r.status === 'success').length;
    if (okCount > 0) toastSuccess(`Đã xoá ${okCount} ứng dụng`);
    const failCount = results.length - okCount;
    if (failCount > 0) toastError(`${failCount} ứng dụng xoá thất bại`);
  }

  function handleClose() {
    setConfirmInput('');
    setShowResults(false);
    setFinalResults([]);
    onOpenChange(false);
    if (finalResults.some((r) => r.status === 'success')) onDone?.();
  }

  const successCount = finalResults.filter((r) => r.status === 'success').length;
  const failCount = finalResults.filter((r) => r.status === 'failed').length;

  if (showResults) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent title="Kết quả xoá ứng dụng">
          <p className="text-sm text-gray-600 mb-3">
            Thành công <strong>{successCount}</strong>/{finalResults.length},
            thất bại <strong className="text-red-600">{failCount}</strong>
          </p>
          {failCount > 0 && (
            <ul className="space-y-1 max-h-48 overflow-y-auto text-sm">
              {finalResults
                .filter((r) => r.status === 'failed')
                .map((r) => (
                  <li key={r.id} className="flex items-start gap-2">
                    <Badge variant="destructive">Lỗi</Badge>
                    <span className="text-gray-700">{r.label}: {r.error}</span>
                  </li>
                ))}
            </ul>
          )}
          <div className="flex justify-end mt-4">
            <Button onClick={handleClose}>Đóng</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        title="Xoá ứng dụng hàng loạt"
        description={`Sẽ xoá vĩnh viễn ${selectedApps.length} ứng dụng: Zitadel project + roles nội bộ. Không thể hoàn tác.`}
      >
        <div className="space-y-4 mt-2">
          <div className="max-h-40 overflow-y-auto text-sm text-gray-600 space-y-1 border border-gray-100 rounded-md p-2 bg-gray-50">
            {selectedApps.map((a) => (
              <div key={a.id} className="truncate">
                <span className="font-mono text-xs text-gray-700">{a.slug}</span>
                <span className="ml-2 text-gray-500">— {a.name}</span>
              </div>
            ))}
          </div>

          <div>
            <p className="text-sm text-gray-700 mb-2">
              Nhập <code className="px-1 py-0.5 bg-gray-100 rounded font-mono text-xs">{CONFIRM_TOKEN}</code> để xác nhận:
            </p>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={CONFIRM_TOKEN}
              autoComplete="off"
              disabled={isRunning}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <DialogClose asChild>
            <Button variant="outline" disabled={isRunning}>Hủy</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={confirmInput !== CONFIRM_TOKEN || isRunning || selectedApps.length === 0}
          >
            {isRunning ? 'Đang xoá...' : `Xoá ${selectedApps.length} ứng dụng`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
