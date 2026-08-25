/**
 * components/layout/header.tsx — Top bar: page title + user email.
 */
import { useAuth } from 'react-oidc-context';
import { usePermissions } from '@/hooks/use-permissions';

interface HeaderProps {
  title?: string;
}

export function Header({ title = 'Quản trị RBAC' }: HeaderProps) {
  const auth = useAuth();
  const { isDegraded } = usePermissions();
  const email = auth.user?.profile?.email ?? auth.user?.profile?.sub ?? '';

  return (
    <header className="h-14 bg-white border-b flex items-center px-6 gap-4 shrink-0">
      {isDegraded && (
        <span className="bg-red-100 text-red-700 text-xs font-medium px-2.5 py-1 rounded-full">
          Hệ thống đang xuống cấp — thao tác bị giới hạn
        </span>
      )}

      <span className="font-medium text-gray-800 text-sm">{title}</span>

      <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        <span>{email}</span>
      </div>
    </header>
  );
}
