/**
 * prod-smoke.integration.ts — Manual smoke test cho SDK vs prod Central.
 * NOT run tự động (KHÔNG có .test.ts extension). Run manually:
 *   tsx tests/prod-smoke.integration.ts
 *
 * Requires:
 *   - CENTRAL_URL env (e.g., https://rbacnb.000nethost.com)
 *   - CENTRAL_RBAC_TOKEN env (từ /opt/central-rbac/.env)
 *   - Existing user_grants on prod cho test user_sub
 */
import { CentralRbacClient, CentralRbacError } from '../src/index.js';

async function main(): Promise<void> {
  const centralUrl = process.env['CENTRAL_URL'] ?? 'https://rbacnb.000nethost.com';
  const token = process.env['CENTRAL_RBAC_TOKEN'];
  const testUserSub = process.env['TEST_USER_SUB'] ?? 'test-sdk-smoke';

  if (!token) {
    console.error('Missing CENTRAL_RBAC_TOKEN env');
    process.exit(1);
  }

  const client = new CentralRbacClient({
    centralUrl,
    appSlug: 'qlts',
    centralRbacToken: token,
    requestTimeoutMs: 5000,
    logger: {
      debug: (obj, msg) => console.log('[DEBUG]', msg, obj),
      info: (obj, msg) => console.log('[INFO]', msg, obj),
      warn: (obj, msg) => console.warn('[WARN]', msg, obj),
      error: (obj, msg) => console.error('[ERROR]', msg, obj),
    },
  });

  try {
    console.log('\n=== Test 1: getEpoch ===');
    const epoch = await client.getEpoch();
    console.log('Epoch:', epoch);

    console.log('\n=== Test 2: resolve (user không có grant) ===');
    const emptyResolve = await client.resolve(testUserSub);
    console.log('Empty resolve:', {
      effective_roles: emptyResolve.effective_roles,
      permissions_count: emptyResolve.permissions.length,
      epoch: emptyResolve.epoch,
    });

    console.log('\n=== Test 3: resolve (cache hit, second call) ===');
    const cached = await client.resolve(testUserSub);
    console.log('Cached:', cached.cached, 'epoch:', cached.epoch);

    console.log('\n=== Test 4: checkPermission ===');
    const check = await client.checkPermission(testUserSub, 'qlts:tickets.read');
    console.log('Check:', check);

    console.log('\n✅ All prod smoke tests OK');
  } catch (err) {
    if (err instanceof CentralRbacError) {
      console.error('❌ Central RBAC error:', err.code, err.message);
    } else {
      console.error('❌ Unexpected error:', err);
    }
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
