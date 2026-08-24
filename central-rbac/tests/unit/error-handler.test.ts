/**
 * error-handler.test.ts — Unit tests for global Fastify error handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { ZodError, z } from 'zod';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { errorHandler } from '../../src/middleware/error-handler.js';
import type { FastifyError } from 'fastify';

function makeReply() {
  const r = {
    _status: 0,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    send(body: unknown) { this._body = body; return this; },
  };
  return r;
}

function makeRequest(url = '/v1/test') {
  return { url, id: 'req-1', ip: '127.0.0.1' } as Parameters<typeof errorHandler>[1];
}

function makeError(overrides: Partial<FastifyError> = {}): FastifyError {
  return {
    name: 'FastifyError',
    message: 'test error',
    code: 'TEST_ERR',
    statusCode: 500,
    ...overrides,
  } as FastifyError;
}

function captureZodError(): ZodError {
  try {
    z.string().parse(123);
  } catch (e) {
    if (e instanceof ZodError) return e;
  }
  throw new Error('expected ZodError');
}

describe('errorHandler', () => {
  it('returns 400 for ZodError cause with validation details', () => {
    const zodErr = captureZodError();
    const err = makeError({ statusCode: 400, cause: zodErr });
    const reply = makeReply();
    errorHandler(err, makeRequest(), reply as never);
    expect(reply._status).toBe(400);
    const body = reply._body as { error: string; details: unknown[] };
    expect(body.error).toBe('Validation error');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('returns 400 for Fastify validation errors', () => {
    const err = makeError({ statusCode: 400, validation: [{ message: 'bad' }] as never[] });
    const reply = makeReply();
    errorHandler(err, makeRequest(), reply as never);
    expect(reply._status).toBe(400);
  });

  it('returns 404 for not-found errors', () => {
    const err = makeError({ statusCode: 404, message: 'Not found' });
    const reply = makeReply();
    errorHandler(err, makeRequest(), reply as never);
    expect(reply._status).toBe(404);
  });

  it('returns 500 for unexpected errors', () => {
    const err = makeError({ statusCode: 500 });
    const reply = makeReply();
    errorHandler(err, makeRequest(), reply as never);
    expect(reply._status).toBe(500);
  });

  it('does not leak stack in production', () => {
    const orig = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const err = makeError({ statusCode: 500, message: 'secret internal detail' });
    const reply = makeReply();
    errorHandler(err, makeRequest(), reply as never);
    expect(JSON.stringify(reply._body)).not.toContain('secret internal detail');
    process.env['NODE_ENV'] = orig;
  });
});
