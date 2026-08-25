/**
 * hooks/use-bulk-grant.ts — Sequential bulk assign with abort-on-unmount cleanup.
 *
 * H2 fix:
 *  - AbortController ref aborts the loop when component unmounts (prevents setState on
 *    unmounted component + dangling isRunning=true state).
 *  - 100-user cap prevents accidental runaway Zitadel fan-out.
 *  - useEffect cleanup registered via returned `cleanup` (caller wires into useEffect).
 */
import { useState, useRef, useCallback } from 'react';
import { createAssignment } from '@/api/assignments';
import type { BulkGrantResult, ZitadelUser } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';

const MAX_BULK_USERS = 100;

interface BulkGrantParams {
  users: ZitadelUser[];
  role_key: string;
}

export function useBulkGrant() {
  const qc = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<BulkGrantResult[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Abort any in-progress loop — safe to call from useEffect cleanup. */
  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  async function run({ users, role_key }: BulkGrantParams) {
    if (users.length > MAX_BULK_USERS) {
      throw new Error(`Chọn tối đa ${MAX_BULK_USERS} người (đang chọn ${users.length})`);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsRunning(true);
    setResults(null);
    const out: BulkGrantResult[] = [];

    for (const user of users) {
      // Stop gracefully if unmounted or cancelled
      if (controller.signal.aborted) break;

      try {
        await createAssignment(user.id, role_key);
        out.push({ uid: user.id, email: user.email, status: 'success' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Lỗi không xác định';
        out.push({ uid: user.id, email: user.email, status: 'failed', error: msg });
      }
    }

    // Only update state if not aborted (component still mounted)
    if (!controller.signal.aborted) {
      void qc.invalidateQueries({ queryKey: ['users'] });
      setResults(out);
      setIsRunning(false);
    }

    return out;
  }

  function reset() {
    setResults(null);
  }

  return { run, abort, isRunning, results, reset };
}
