/**
 * router.tsx — Application routes.
 * / → redirect to /users
 * /login — public login page
 * /callback — OIDC callback handler
 * /users, /users/:id — protected, requires rbac.admin.read
 */
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/app-shell';
import { ProtectedRoute } from '@/auth/protected-route';
import { LoginPage } from '@/pages/login/login-page';
import { CallbackPage } from '@/pages/login/callback-page';
import { SilentRenewPage } from '@/pages/login/silent-renew-page';
import { UsersListPage } from '@/pages/users/users-list-page';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/callback',
    element: <CallbackPage />,
  },
  {
    // H1 fix: silent renew iframe target — must be reachable without auth
    path: '/silent-renew',
    element: <SilentRenewPage />,
  },
  {
    path: '/',
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/users" replace /> },
          { path: 'users', element: <UsersListPage /> },
          // /users/:id is handled as a drawer overlay within UsersListPage
          { path: 'users/:id', element: <UsersListPage /> },
        ],
      },
    ],
  },
]);
