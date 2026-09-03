/**
 * hooks/use-bulk-delete.ts — Sequential bulk delete with abort-on-unmount.
 * Generic: caller supplies a deleteFn + items with { id, label } fields.
 * Mirrors use-bulk-grant pattern (100-item cap, AbortController).
 */
import { useState, useRef, useCallback } from 'react';

const MAX_BULK_ITEMS = 100;

export interface BulkDeleteItem {
  id: string;
  label: string;
}

export interface BulkDeleteResult {
  id: string;
  label: string;
  status: 'success' | 'failed';
  error?: string;
}

export function useBulkDelete(deleteFn: (id: string) => Promise<void>, onFinish?: () => void) {
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  async function run(items: BulkDeleteItem[]): Promise<BulkDeleteResult[]> {
    if (items.length > MAX_BULK_ITEMS) {
      throw new Error(`Chọn tối đa ${MAX_BULK_ITEMS} mục (đang chọn ${items.length})`);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsRunning(true);
    const out: BulkDeleteResult[] = [];

    for (const item of items) {
      if (controller.signal.aborted) break;
      try {
        await deleteFn(item.id);
        out.push({ id: item.id, label: item.label, status: 'success' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Lỗi không xác định';
        out.push({ id: item.id, label: item.label, status: 'failed', error: msg });
      }
    }

    if (!controller.signal.aborted) {
      setIsRunning(false);
      onFinish?.();
    }
    return out;
  }

  return { run, abort, isRunning };
}
