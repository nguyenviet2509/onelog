/**
 * components/ui/dropdown-menu.tsx — Compact action dropdown using Radix.
 *
 * Usage:
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild>
 *       <Button size="sm" variant="outline">Actions ▾</Button>
 *     </DropdownMenuTrigger>
 *     <DropdownMenuContent>
 *       <DropdownMenuItem onSelect={...}>Edit</DropdownMenuItem>
 *       <DropdownMenuItem destructive onSelect={...}>Delete</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 *
 * Radix handles keyboard nav (arrows, Esc, tab-out), focus trap, positioning.
 */
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuSeparator = () => (
  <RadixMenu.Separator className="my-1 h-px bg-gray-100" />
);

interface DropdownMenuContentProps {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

export function DropdownMenuContent({
  children,
  className,
  align = 'end',
  sideOffset = 4,
}: DropdownMenuContentProps) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[10rem] rounded-md border border-gray-200 bg-white p-1 shadow-lg',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

interface DropdownMenuItemProps {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  disabled?: boolean;
  destructive?: boolean;
  className?: string;
  asChild?: boolean;
}

export function DropdownMenuItem({
  children,
  onSelect,
  disabled,
  destructive,
  className,
  asChild,
}: DropdownMenuItemProps) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      asChild={asChild}
      className={cn(
        'flex items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none cursor-pointer',
        'transition-colors',
        destructive
          ? 'text-red-600 focus:bg-red-50 focus:text-red-700'
          : 'text-gray-700 focus:bg-gray-100 focus:text-gray-900',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      {children}
    </RadixMenu.Item>
  );
}
