/**
 * components/ui/dialog.tsx — Modal dialog using Radix UI Dialog primitive.
 *
 * @responsive Width is `calc(100vw-1rem)` capped at `max-w-lg` so phones get an
 * 8px margin each side. Padding + max-height shrink on mobile; body scrolls
 * when content overflows viewport.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

interface DialogContentProps {
  children: ReactNode;
  className?: string;
  title?: string;
  description?: string;
}

export function DialogContent({ children, className, title, description }: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-[calc(100vw-1rem)] max-w-lg bg-white rounded-lg shadow-xl p-4 sm:p-6',
          'max-h-[calc(100vh-2rem)] overflow-y-auto',
          'focus:outline-none',
          className,
        )}
      >
        {title && (
          <RadixDialog.Title className="text-lg font-semibold text-gray-900 mb-1">
            {title}
          </RadixDialog.Title>
        )}
        {description && (
          <RadixDialog.Description className="text-sm text-gray-500 mb-4">
            {description}
          </RadixDialog.Description>
        )}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
