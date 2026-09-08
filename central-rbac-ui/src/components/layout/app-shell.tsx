/**
 * components/layout/app-shell.tsx — Root layout: sidebar + header + outlet.
 * Also renders REVIEW MODE banner when VITE_REVIEW_MODE=true.
 *
 * @responsive Sidebar becomes off-canvas drawer < lg (1024px). Hamburger in
 * Header toggles. New pages using AppShell inherit mobile layout for free.
 */
import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { Header } from './header';

const IS_REVIEW_MODE = import.meta.env.VITE_REVIEW_MODE === 'true';

/**
 * Radix Dialog / Drawer sometimes leaves `body.style.pointerEvents = 'none'` stuck
 * after close/unmount (race between onOpenChange cleanup and route change).
 * Symptom: user clicks sidebar navlinks → nothing fires → stuck on current page.
 * Guard: watch body style and clear pointer-events whenever no dialog is open.
 */
function useRadixPointerEventsGuard() {
  useEffect(() => {
    const clearIfSafe = () => {
      if (document.body.style.pointerEvents === 'none') {
        const anyOpen = document.querySelector('[data-state="open"][role="dialog"]');
        if (!anyOpen) document.body.style.pointerEvents = '';
      }
    };
    // Initial cleanup on mount (in case we entered mid-stuck state).
    clearIfSafe();
    const observer = new MutationObserver(clearIfSafe);
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useRadixPointerEventsGuard();

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        {IS_REVIEW_MODE && (
          <div className="bg-yellow-400 text-yellow-900 text-xs font-semibold text-center py-1.5 px-4 shrink-0">
            REVIEW MODE — không dùng cho production
          </div>
        )}
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
