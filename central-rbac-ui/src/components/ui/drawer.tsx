/**
 * components/ui/drawer.tsx — Right-side slide-in drawer using Radix Dialog.
 * Used for User Detail — no external drawer library needed.
 *
 * @responsive `w-full` fills viewport < sm (max-w-2xl caps at ≥ sm). Header +
 * body padding tighten on mobile.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export const Drawer = RadixDialog.Root;
export const DrawerTrigger = RadixDialog.Trigger;
export const DrawerClose = RadixDialog.Close;

interface DrawerContentProps {
  children: ReactNode;
  className?: string;
  title?: string;
}

export function DrawerContent({ children, className, title }: DrawerContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
      <RadixDialog.Content
        className={cn(
          'fixed right-0 top-0 h-full w-full max-w-2xl bg-white shadow-2xl z-50',
          'flex flex-col overflow-hidden',
          'data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
          'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
          'duration-300',
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b px-4 sm:px-6 py-3 sm:py-4 shrink-0">
            <RadixDialog.Title className="text-base sm:text-lg font-semibold text-gray-900 truncate pr-3">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none p-1 -m-1 shrink-0"
              aria-label="Đóng"
            >
              ×
            </RadixDialog.Close>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
