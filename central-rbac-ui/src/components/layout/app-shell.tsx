/**
 * components/layout/app-shell.tsx — Root layout: sidebar + header + outlet.
 * Also renders REVIEW MODE banner when VITE_REVIEW_MODE=true.
 */
import { Outlet } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { Header } from './header';

const IS_REVIEW_MODE = import.meta.env.VITE_REVIEW_MODE === 'true';

export function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />

      <div className="flex flex-col flex-1 overflow-hidden">
        {IS_REVIEW_MODE && (
          <div className="bg-yellow-400 text-yellow-900 text-xs font-semibold text-center py-1.5 px-4 shrink-0">
            REVIEW MODE — không dùng cho production
          </div>
        )}
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
