/**
 * OpenWebUI API client — KB Phase 1 integration.
 *
 * Env vars:
 *   OPENWEBUI_URL — required, e.g. http://openwebui:8080 (inside docker network)
 *
 * All functions throw on network error; callers map HTTP status codes to their
 * own error responses. No retry logic here — caller decides retry semantics.
 *
 * OpenWebUI REST API endpoints used:
 *   GET  /api/v1/chats/{id}          — fetch chat + verify ownership
 *   GET  /api/v1/auths                — get current user from JWT
 *   GET  /api/v1/chats/all            — list all chats (admin key, backfill)
 */

import type { OpenWebUIMessage } from "./summarizer-prompt";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function openwebuiUrl(): string {
  const url = process.env.OPENWEBUI_URL;
  if (!url) throw new Error("OPENWEBUI_URL not set");
  return url.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenWebUIUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

export interface OpenWebUIChatSummary {
  id: string;
  title?: string;
  user_id?: string;
  created_at?: number;
  updated_at?: number;
}

/** Full chat object returned by GET /api/v1/chats/{id} */
interface OpenWebUIChatFull {
  id: string;
  user_id?: string;
  title?: string;
  chat?: {
    messages?: Array<{
      id?: string;
      role: string;
      content: string;
      timestamp?: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- citations structure varies by plugin
      citations?: any[];
    }>;
  };
}

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

async function owFetch(
  path: string,
  jwt: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${openwebuiUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: jwt.startsWith("Bearer ") ? jwt : `Bearer ${jwt}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // N9: On non-2xx, read raw body text first so we can log it for debugging
  // (OpenWebUI 5xx bodies are discarded if we go straight to res.json()).
  if (!res.ok) {
    let rawBody = "";
    try {
      rawBody = await res.text();
    } catch {
      rawBody = "<unreadable>";
    }
    // Log first 200 chars to avoid flooding logs with large HTML error pages
    console.warn(
      `openwebui.owFetch non-2xx status=${res.status} path=${path} body=${rawBody.slice(0, 200)}`,
    );
    // Try to parse as JSON for callers that inspect .data; fall back to null
    let data: unknown = null;
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the JWT owner has access to the given chat.
 * Returns ok=true + chatData on 200; ok=false on 401/403/404.
 * Throws on network error or unexpected status.
 */
export async function verifyOwnership(
  chatId: string,
  jwt: string,
): Promise<{ ok: boolean; chatData?: OpenWebUIChatFull }> {
  const { status, data } = await owFetch(`/api/v1/chats/${chatId}`, jwt);

  if (status === 200) {
    return { ok: true, chatData: data as OpenWebUIChatFull };
  }
  if (status === 401 || status === 403 || status === 404) {
    return { ok: false };
  }

  throw new Error(`OpenWebUI verifyOwnership unexpected status ${status}`);
}

/**
 * Fetch the messages array from an OpenWebUI chat.
 * Requires prior ownership verification — this just extracts messages.
 * Pass chatData from verifyOwnership to avoid a double HTTP call.
 */
export async function fetchChatMessages(
  chatId: string,
  jwt: string,
  chatData?: OpenWebUIChatFull,
): Promise<OpenWebUIMessage[]> {
  let data = chatData;

  if (!data) {
    const result = await owFetch(`/api/v1/chats/${chatId}`, jwt);
    if (result.status !== 200) {
      throw new Error(`OpenWebUI fetchChatMessages status ${result.status} for chat ${chatId}`);
    }
    data = result.data as OpenWebUIChatFull;
  }

  // OpenWebUI stores messages under chat.messages
  const messages = data?.chat?.messages ?? [];
  return messages.map((m) => ({
    role: m.role,
    content: m.content ?? "",
    timestamp: m.timestamp,
    citations: m.citations,
  }));
}

/**
 * Get the currently authenticated user from a JWT.
 * Returns user object on 200; null on 401/403.
 * Used by /api/kb/entries to identify the submitting user.
 */
export async function getCurrentUser(jwt: string): Promise<OpenWebUIUser | null> {
  const { status, data } = await owFetch("/api/v1/auths", jwt);

  if (status === 200) {
    const user = data as { id?: string; email?: string; name?: string; role?: string };
    if (!user?.id) return null;
    return {
      id: String(user.id),
      email: user.email ?? "",
      name: user.name,
      role: user.role,
    };
  }

  if (status === 401 || status === 403) return null;

  throw new Error(`OpenWebUI getCurrentUser unexpected status ${status}`);
}

/**
 * List all chats — used by backfill script with admin API key.
 * OpenWebUI supports GET /api/v1/chats/all (admin-only endpoint).
 * Falls back to paginated /api/v1/chats?skip=&limit= if /all returns 403.
 *
 * @param adminKey  OpenWebUI admin API key (not a JWT — this is a long-lived key)
 * @param skip      Pagination offset
 * @param limit     Page size (default 50)
 */
export async function listAllChats(
  adminKey: string,
  skip = 0,
  limit = 50,
): Promise<OpenWebUIChatSummary[]> {
  // Try /api/v1/chats/all first (admin-only, no pagination needed)
  const allResult = await owFetch(
    `/api/v1/chats/all?skip=${skip}&limit=${limit}`,
    adminKey,
  );

  if (allResult.status === 200) {
    const items = Array.isArray(allResult.data) ? allResult.data : [];
    return items.map((c) => ({
      id: String(c.id),
      title: c.title,
      user_id: c.user_id,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  }

  // Fallback to paginated user-visible list
  if (allResult.status === 403 || allResult.status === 404) {
    const fallback = await owFetch(
      `/api/v1/chats?skip=${skip}&limit=${limit}`,
      adminKey,
    );
    if (fallback.status !== 200) {
      throw new Error(
        `OpenWebUI listAllChats fallback status ${fallback.status}`,
      );
    }
    const items = Array.isArray(fallback.data) ? fallback.data : [];
    return items.map((c) => ({
      id: String(c.id),
      title: c.title,
      user_id: c.user_id,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  }

  throw new Error(`OpenWebUI listAllChats unexpected status ${allResult.status}`);
}
