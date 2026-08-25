/**
 * components/confirm-dialog.tsx — Reusable confirmation dialog with optional type-verify input.
 * Used for revoke flow: user must type email or "REVOKE" to confirm.
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogClose } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** If set, user must type this string to enable confirm button */
  typeVerify?: string;
  typeVerifyLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void | Promise<void>;
  isLoading?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  typeVerify,
  typeVerifyLabel,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy',
  variant = 'default',
  onConfirm,
  isLoading,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const canConfirm = !typeVerify || inputValue === typeVerify;

  function handleConfirm() {
    void onConfirm();
  }

  function handleOpenChange(v: boolean) {
    if (!v) setInputValue('');
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title={title} description={description}>
        {typeVerify && (
          <div className="mb-4">
            <p className="text-sm text-gray-600 mb-2">
              {typeVerifyLabel ?? `Nhập "${typeVerify}" để xác nhận:`}
            </p>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={typeVerify}
              autoComplete="off"
            />
          </div>
        )}

        <div className="flex justify-end gap-3 mt-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={isLoading}>{cancelLabel}</Button>
          </DialogClose>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={!canConfirm || isLoading}
          >
            {isLoading ? 'Đang xử lý...' : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
