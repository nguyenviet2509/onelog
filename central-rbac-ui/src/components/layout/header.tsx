/**
 * components/layout/header.tsx — Top bar: page title + admin profile menu.
 *
 * Reads displayName via useMe (OIDC claim fallback chain: name → preferred_username
 * → email → sub-short). Avatar = first letter of displayName. Dropdown holds
 * Đăng xuất only for now (YAGNI: no profile page, no copy-id — add when needed).
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { usePermissions } from '@/hooks/use-permissions';
import { useMe } from '@/hooks/use-me';

interface HeaderProps {
  title?: string;
}

export function Header({ title = 'Quản trị RBAC' }: HeaderProps) {
  const auth = useAuth();
  const { isDegraded } = usePermissions();
  const { data: me } = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  function handleLogout() {
    setMenuOpen(false);
    void auth.signoutRedirect();
  }

  return (
    <header className="h-14 bg-white border-b flex items-center px-6 gap-4 shrink-0">
      {isDegraded && (
        <span className="bg-red-100 text-red-700 text-xs font-medium px-2.5 py-1 rounded-full">
          Hệ thống đang xuống cấp — thao tác bị giới hạn
        </span>
      )}

      <span className="font-medium text-gray-800 text-sm">{title}</span>

      <div className="ml-auto relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-gray-100 transition-colors"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 font-semibold flex items-center justify-center text-xs">
            {me?.initial ?? '?'}
          </span>
          <span className="text-sm text-gray-700 max-w-[160px] truncate">
            {me?.displayName ?? '...'}
          </span>
          <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1"
          >
            {me?.email && (
              <div className="px-3 py-2 border-b border-gray-100">
                <div className="text-sm font-medium text-gray-900 truncate">{me.displayName}</div>
                <div className="text-xs text-gray-500 truncate">{me.email}</div>
              </div>
            )}
            <button
              role="menuitem"
              onClick={handleLogout}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Đăng xuất
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
