/**
 * api/client.ts — Axios instance with Bearer interceptor, 401 → /login, 403 toast.
 *
 * 401 flow: local clear rbac session (removeUser) → navigate to /login landing.
 * User click "Đăng nhập qua Zitadel" → SSO silent (Zitadel session còn 10 ngày)
 * → back to app. Không end_session Zitadel → không phải chọn lại IdP.
 * Auto signinRedirect() bỏ đi (bug: gây loop, người dùng không thấy được logout).
 */
import axios, { type AxiosError } from 'axios';
import { userManager } from '@/auth/oidc-client';
import { toastError } from '@/lib/toast-bus';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string) || '/v1';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Attach Bearer token from sessionStorage on every request
apiClient.interceptors.request.use(async (config) => {
  const user = await userManager.getUser();
  if (user?.access_token) {
    config.headers['Authorization'] = `Bearer ${user.access_token}`;
  }
  return config;
});

// Handle 401 (local re-auth via /login landing) and 403 (toast)
apiClient.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      void userManager.removeUser().then(() => {
        // Axios interceptor is outside React Router — use hard nav.
        window.location.href = '/login';
      });
    } else if (err.response?.status === 403) {
      toastError('Bạn không có quyền thực hiện thao tác này.');
    }
    return Promise.reject(err);
  },
);
