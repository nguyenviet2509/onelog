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

/**
 * Bypass React Router's useLocation and subscribe directly to browser history.
 * Diagnostic 2026-09-08 confirmed that after NavLink click:
 *   - window.location.pathname DOES update
 *   - React Router's useLocation() returns STALE pathname
 *   - <Outlet key={useLocation().pathname}> therefore does not re-mount
 * Root cause suspected: React 19 concurrent scheduler + Router's
 * useSyncExternalStore selector short-circuits on rapid transitions.
 * This hook intercepts pushState/replaceState to force our own reactive
 * pathname state, independent of React Router internals.
 */
function useBrowserPathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    window.history.pushState = function (...args) {
      origPush.apply(this, args as Parameters<typeof origPush>);
      sync();
    };
    window.history.replaceState = function (...args) {
      origReplace.apply(this, args as Parameters<typeof origReplace>);
      sync();
    };
    window.addEventListener('popstate', sync);
    return () => {
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
      window.removeEventListener('popstate', sync);
    };
  }, []);
  return pathname;
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = useBrowserPathname();
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
          {/* key={pathname} forces React to unmount/mount page on route change.
              Defensive against React Router edge cases where Outlet fails to
              re-render (e.g. useSyncExternalStore selector short-circuits under
              React 19 concurrent mode). Diagnostic 2026-09-08 showed URL updated
              but Outlet element stayed as previous page. */}
          <Outlet key={pathname} />
        </main>
      </div>
    </div>
  );
}
