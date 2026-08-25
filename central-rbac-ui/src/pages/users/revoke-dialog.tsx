/**
 * pages/users/revoke-dialog.tsx — Revoke a grant with type-to-confirm safety check.
 * User must type their email or "REVOKE" to enable the submit button.
 */
import { useRevokeMutation } from '@/hooks/use-assignments-query';
import { ConfirmDialog } from '@/components/confirm-dialog';

interface RevokeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
  grantId: string;
  roleKey?: string;
}

export function RevokeDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
  grantId,
  roleKey,
}: RevokeDialogProps) {
  const revoke = useRevokeMutation(userId, userEmail);

  function handleConfirm() {
    revoke.mutate(
      { grant_id: grantId, role_key: roleKey },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Thu hồi quyền"
      description={`Bạn sắp thu hồi quyền${roleKey ? ` "${roleKey}"` : ''} của ${userEmail}. Hành động này không thể hoàn tác.`}
      typeVerify={userEmail}
      typeVerifyLabel={`Nhập email "${userEmail}" để xác nhận:`}
      confirmLabel="Thu hồi"
      variant="destructive"
      onConfirm={handleConfirm}
      isLoading={revoke.isPending}
    />
  );
}
