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
      ],
      // logger.ts is a pino singleton — no testable logic, excluded from thresholds
      exclude: ['src/lib/logger.ts'],
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
