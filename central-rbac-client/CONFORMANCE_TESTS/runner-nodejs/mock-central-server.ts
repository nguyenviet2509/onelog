/**
 * mock-central-server.ts — Fastify mock Central RBAC for conformance tests.
 *
 * Simulates POST /v2/resolve, GET /v2/epoch/:app_slug endpoints.
 * Test-controllable: set response mode, bump epoch, count calls.
 *
 * No auth checks by default (per-test override via setAuthValidator).
 * Always emits X-Api-Version header (default '2', override via setApiVersion).
 */
import Fastify, { type FastifyInstance } from 'fastify';

export type MockMode =
  | 'ok'                 // 200 with configured payload
  | 'unauthorized'       // 401
  | 'not_found'          // 404
  | 'server_error'       // 500
  | 'unreachable';       // simulate timeout (delay > SDK timeout)

interface CountersState {
  resolveCalls: number;
  epochCalls: number;
  lastResolveBody?: unknown;
  lastAuthHeader?: string;
}

export interface MockControls {
  server: FastifyInstance;
  baseUrl: string;
  counters: CountersState;
  setMode(mode: MockMode): void;
  setEpoch(epoch: number): void;
  setApiVersion(version: string | null): void;   // null = omit header
  setResolvePayload(payload: Record<string, unknown>): void;
  reset(): void;
  stop(): Promise<void>;
}

export async function startMockCentral(port = 0): Promise<MockControls> {
  const app = Fastify({ logger: false });

  let mode: MockMode = 'ok';
  let epoch = 1;
  let apiVersion: string | null = '2';
  let resolvePayload: Record<string, unknown> = {
    user_sub: 'user-1',
    app_slug: 'test-app',
    tenant_id: null,
    effective_roles: ['test.viewer'],
    permissions: ['test:read'],
    epoch: 1,
    cached: false,
  };

  const counters: CountersState = { resolveCalls: 0, epochCalls: 0 };

  app.addHook('onSend', async (_req, reply, payload) => {
    if (apiVersion !== null) {
      reply.header('X-Api-Version', apiVersion);
    }
    return payload;
  });

  app.post('/v2/resolve', async (req, reply) => {
    counters.resolveCalls += 1;
    counters.lastResolveBody = req.body;
    counters.lastAuthHeader = req.headers['x-rbac-token'] as string | undefined;

    if (mode === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });
    if (mode === 'not_found') return reply.code(404).send({ error: 'app not found' });
    if (mode === 'server_error') return reply.code(500).send({ error: 'internal' });
    if (mode === 'unreachable') {
      await new Promise((r) => setTimeout(r, 2000));    // > SDK timeout
      return reply.code(200).send(resolvePayload);
    }

    // Body echo (respect user_sub/tenant_id/app_slug from request)
    const body = req.body as { user_sub?: string; app_slug?: string; tenant_id?: string | null };
    return reply.code(200).send({
      ...resolvePayload,
      user_sub: body.user_sub ?? resolvePayload['user_sub'],
      app_slug: body.app_slug ?? resolvePayload['app_slug'],
      tenant_id: body.tenant_id ?? resolvePayload['tenant_id'] ?? null,
      epoch,
    });
  });

  app.get('/v2/epoch/:app_slug', async (_req, reply) => {
    counters.epochCalls += 1;
    if (mode === 'server_error') return reply.code(500).send({ error: 'internal' });
    if (mode === 'unreachable') {
      await new Promise((r) => setTimeout(r, 2000));
      return reply.code(200).send({ epoch });
    }
    return reply.code(200).send({ epoch, cached: true });
  });

  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('mock: no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    server: app,
    baseUrl,
    counters,
    setMode(m) { mode = m; },
    setEpoch(e) { epoch = e; },
    setApiVersion(v) { apiVersion = v; },
    setResolvePayload(p) { resolvePayload = { ...resolvePayload, ...p }; },
    reset() {
      mode = 'ok';
      epoch = 1;
      apiVersion = '2';
      counters.resolveCalls = 0;
      counters.epochCalls = 0;
      counters.lastResolveBody = undefined;
      counters.lastAuthHeader = undefined;
    },
    async stop() { await app.close(); },
  };
}
