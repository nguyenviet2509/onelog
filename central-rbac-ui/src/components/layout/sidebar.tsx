/**
 * components/layout/sidebar.tsx — Left nav: Người dùng + Logout.
 */
import { NavLink } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const auth = useAuth();

  function handleLogout() {
    void auth.signoutRedirect();
  }

  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col h-full">
      <div className="px-5 py-5 border-b border-gray-700">
        <span className="text-base font-semibold tracking-tight">Central RBAC</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Điều hướng chính">
        <NavLink
          to="/users"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-800 hover:text-white',
            )
          }
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Người dùng
        </NavLink>
      </nav>

      <div className="px-3 py-4 border-t border-gray-700">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full rounded-md px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Đăng xuất
        </button>
      </div>
    </aside>
  );
}
