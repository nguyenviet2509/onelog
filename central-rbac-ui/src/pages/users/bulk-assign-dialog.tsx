/**
 * pages/users/bulk-assign-dialog.tsx — Bulk assign a role to multiple selected users.
 * Plain sequential for-loop; shows result summary modal after completion.
 *
 * H2 fix: abort() wired in useEffect so closing the dialog mid-run stops the loop
 * and prevents setState-on-unmounted-component + dangling isRunning=true state.
 */
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { listRoles } from '@/api/roles';
import { useBulkGrant } from '@/hooks/use-bulk-grant';
import type { ZitadelUser, BulkGrantResult } from '@/lib/types';

interface BulkAssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUsers: ZitadelUser[];
}

export function BulkAssignDialog({ open, onOpenChange, selectedUsers }: BulkAssignDialogProps) {
  const [selectedRole, setSelectedRole] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [finalResults, setFinalResults] = useState<BulkGrantResult[]>([]);

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: listRoles,
    staleTime: 5 * 60_000,
  });

  const { run, abort, isRunning } = useBulkGrant();

  // Abort in-progress loop when dialog closes or component unmounts
  useEffect(() => {
    if (!open) abort();
    return () => abort();
  }, [open, abort]);

  async function handleSubmit() {
    if (!selectedRole || selectedUsers.length === 0) return;
    const results = await run({ users: selectedUsers, role_key: selectedRole });
    setFinalResults(results);
    setShowResults(true);
  }

  function handleClose() {
    setSelectedRole('');
    setShowResults(false);
    setFinalResults([]);
    onOpenChange(false);
  }

  const successCount = finalResults.filter((r) => r.status === 'success').length;
  const failCount = finalResults.filter((r) => r.status === 'failed').length;

  if (showResults) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent title="Kết quả cấp quyền hàng loạt">
          <p className="text-sm text-gray-600 mb-3">
            Thành công <strong>{successCount}</strong>/{finalResults.length},
            thất bại <strong className="text-red-600">{failCount}</strong>
          </p>
          {failCount > 0 && (
            <ul className="space-y-1 max-h-48 overflow-y-auto text-sm">
              {finalResults
                .filter((r) => r.status === 'failed')
                .map((r) => (
                  <li key={r.uid} className="flex items-start gap-2">
                    <Badge variant="destructive">Lỗi</Badge>
                    <span className="text-gray-700">{r.email}: {r.error}</span>
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
        title="Cấp quyền hàng loạt"
        description={`Đã chọn ${selectedUsers.length} người dùng`}
      >
        <div className="space-y-4 mt-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vai trò</label>
            <Select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)}>
              <option value="">-- Chọn vai trò --</option>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.display_name} ({r.key})
                </option>
              ))}
            </Select>
          </div>

          <div className="max-h-32 overflow-y-auto text-sm text-gray-600 space-y-1">
            {selectedUsers.map((u) => (
              <div key={u.id} className="truncate">{u.email}</div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <DialogClose asChild>
            <Button variant="outline" disabled={isRunning}>Hủy</Button>
          </DialogClose>
          <Button
            onClick={handleSubmit}
            disabled={!selectedRole || isRunning || selectedUsers.length === 0}
          >
            {isRunning ? 'Đang xử lý...' : `Cấp quyền cho ${selectedUsers.length} người`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
