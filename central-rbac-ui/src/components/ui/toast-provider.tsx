/**
 * components/ui/toast-provider.tsx — Toast notification system using Radix Toast.
 * Registers as the global toast-bus listener so api/client can fire toasts.
 */
import { useEffect, useRef, useState } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import { registerToastListener } from '@/lib/toast-bus';
import { cn } from '@/lib/utils';

interface ToastItem {
  id: number;
  message: string;
  variant: 'error' | 'success';
}

export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    registerToastListener((msg, variant) => {
      const id = ++counter.current;
      setToasts((prev) => [...prev, { id, message: msg, variant }]);
    });
  }, []);

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <RadixToast.Provider swipeDirection="right" duration={4000}>
      {toasts.map((toast) => (
        <RadixToast.Root
          key={toast.id}
          open
          onOpenChange={(open) => { if (!open) dismiss(toast.id); }}
          className={cn(
            'flex items-center justify-between gap-4 rounded-lg px-4 py-3 shadow-lg text-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-80 data-[state=open]:fade-in-0',
            toast.variant === 'error'
              ? 'bg-red-600 text-white'
              : 'bg-green-600 text-white',
          )}
        >
          <RadixToast.Description>{toast.message}</RadixToast.Description>
          <RadixToast.Action altText="Đóng" asChild>
            <button
              onClick={() => dismiss(toast.id)}
              className="text-white/80 hover:text-white font-bold text-base leading-none"
            >
              ×
            </button>
          </RadixToast.Action>
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-full" />
    </RadixToast.Provider>
  );
}
