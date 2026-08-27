/**
 * pages/users/revoke-dialog.tsx — Revoke a grant with type-to-confirm safety check.
 *
 * roleKeys mode: [] = revoke entire grant; non-empty = partial revoke of listed roles.
 * Type-verify by email guards against accidental clicks in the drawer.
 */
import { useRevokeMutation } from '@/hooks/use-assignments-query';
import { ConfirmDialog } from '@/components/confirm-dialog';

interface RevokeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
  grantId: string;
  /** Empty = revoke entire grant; non-empty = revoke listed roles only. */
  roleKeys: string[];
  /** Human-readable project label for the confirmation prompt. */
  projectLabel?: string;
}

export function RevokeDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
  grantId,
  roleKeys,
  projectLabel,
}: RevokeDialogProps) {
  const revoke = useRevokeMutation(userId, userEmail);

  const isFull = roleKeys.length === 0;
  const scopeLabel = isFull
    ? `toàn bộ quyền${projectLabel ? ` trong "${projectLabel}"` : ''}`
    : roleKeys.length === 1
      ? `quyền "${roleKeys[0]}"`
      : `${roleKeys.length} quyền (${roleKeys.join(', ')})`;

  function handleConfirm() {
    revoke.mutate(
      { grant_id: grantId, role_keys: roleKeys },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isFull ? 'Thu hồi toàn bộ quyền' : 'Thu hồi quyền'}
      description={`Bạn sắp thu hồi ${scopeLabel} của ${userEmail}. Hành động này không thể hoàn tác.`}
      typeVerify={userEmail}
      typeVerifyLabel={`Nhập email "${userEmail}" để xác nhận:`}
      confirmLabel="Thu hồi"
      variant="destructive"
      onConfirm={handleConfirm}
      isLoading={revoke.isPending}
    />
  );
}
