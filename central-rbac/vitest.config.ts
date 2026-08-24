import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    coverage: {
      provider: 'v8',
      // Only measure coverage on pure logic files testable without DB/network.
      // Routes, DB queries, schemas, and app.ts require integration tests (Docker Postgres).
      include: [
        'src/lib/**/*.ts',
        'src/middleware/auth-jwt.ts',
        'src/middleware/auth-resolve.ts',
        'src/middleware/error-handler.ts',
        'src/middleware/zitadel-action-hmac.ts',
      ],
      // Excluded from coverage thresholds:
      // - logger.ts: pino singleton, no testable logic
      // - redis-client.ts: ioredis network singleton, requires live Redis for meaningful coverage
      exclude: ['src/lib/logger.ts', 'src/lib/redis-client.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
      reporter: ['text', 'lcov'],
    },
    testTimeout: 10_000,
  },
});
