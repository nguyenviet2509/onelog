/**
 * api/client.ts — Axios instance with Bearer interceptor, 401 force-logout, 403 toast.
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

// Handle 401 (force logout) and 403 (toast)
apiClient.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      void userManager.signoutRedirect();
    } else if (err.response?.status === 403) {
      toastError('Bạn không có quyền thực hiện thao tác này.');
    }
    return Promise.reject(err);
  },
);
