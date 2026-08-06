/**
 * Application-level smoke tests.
 *
 * Exercises the real Express app through HTTP — the whole middleware chain,
 * routing, error handling and response envelope — without needing MongoDB or
 * Redis. Unit tests verify each piece in isolation; this verifies they are
 * actually wired together, which is the failure that unit tests never catch.
 *
 * Anything that genuinely needs a database is covered by the CI smoke job
 * against the full compose stack.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';

let app: Express;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  // Redis clients are created at import time; close them so vitest can exit.
  const { disconnectRedis } = await import('../src/lib/redis');
  await disconnectRedis().catch(() => undefined);
});

describe('service discovery', () => {
  it('advertises its documentation from the root', async () => {
    const response = await request(app).get('/').expect(200);
    expect(response.body).toMatchObject({
      service: 'aarvion-crm-api',
      documentation: '/api/v1/docs',
    });
  });
});

describe('liveness', () => {
  it('responds without touching any dependency', async () => {
    // The point of this probe: it must succeed even when MongoDB is down.
    const response = await request(app).get('/api/v1/health/live').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('OpenAPI document', () => {
  it('is served and well-formed', async () => {
    const response = await request(app).get('/api/v1/openapi.json').expect(200);
    expect(response.body.openapi).toMatch(/^3\./);
    expect(response.body.info.title).toBe('Aarvion CRM API');
  });

  it('documents every mounted route group', async () => {
    const response = await request(app).get('/api/v1/openapi.json');
    const paths = Object.keys(response.body.paths as Record<string, unknown>);

    for (const prefix of ['/auth/login', '/leads', '/imports', '/ai/score', '/analytics/funnel', '/health']) {
      expect(paths).toContain(prefix);
    }
  });

  it('declares both auth transports', async () => {
    const response = await request(app).get('/api/v1/openapi.json');
    expect(response.body.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(response.body.components.securitySchemes).toHaveProperty('cookieAuth');
  });
});

describe('authentication guard', () => {
  it.each([
    ['get', '/api/v1/leads'],
    ['get', '/api/v1/leads/stats'],
    ['get', '/api/v1/imports'],
    ['get', '/api/v1/analytics/funnel'],
    ['post', '/api/v1/ai/search'],
  ])('rejects unauthenticated %s %s', async (method, path) => {
    const response = await (request(app) as never as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    const response = await request(app)
      .get('/api/v1/leads')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('validation', () => {
  it('returns field-level errors in the documented shape', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields).toHaveProperty('email');
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'jane@acme.com', password: 'secret', role: 'OWNER' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('reports malformed JSON as a 400, not a 500', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('error envelope', () => {
  it('returns a consistent shape for unmatched routes', async () => {
    const response = await request(app).get('/api/v1/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body).toHaveProperty('requestId');
  });
});

describe('request correlation', () => {
  it('returns a request id on every response', async () => {
    const response = await request(app).get('/api/v1/health/live');
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it('honours a well-formed inbound request id', async () => {
    const inbound = 'trace-abc-123456';
    const response = await request(app).get('/api/v1/health/live').set('x-request-id', inbound);
    expect(response.headers['x-request-id']).toBe(inbound);
  });

  it.each([
    ['spaces', 'bad id with spaces'],
    ['too short', 'abc'],
    ['too long', 'x'.repeat(200)],
    ['punctuation used by log formats', 'id";DROP--'],
  ])('replaces an inbound id containing %s instead of echoing it', async (_label, malformed) => {
    // This value ends up in log lines and in a response header. Echoing an
    // unvalidated client-controlled string is how log injection happens.
    //
    // Note: a literal newline cannot be tested through an HTTP client — Node
    // rejects it before it leaves the socket — so the cases here are the ones
    // that are actually transmissible.
    const response = await request(app).get('/api/v1/health/live').set('x-request-id', malformed);

    expect(response.headers['x-request-id']).not.toBe(malformed);
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });
});

describe('security headers', () => {
  it('sets the headers helmet is configured for', async () => {
    const response = await request(app).get('/api/v1/health/live');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('does not advertise the framework', async () => {
    const response = await request(app).get('/api/v1/health/live');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const response = await request(app)
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:3000');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin that is not on the allow-list', async () => {
    // With `credentials: true`, echoing an arbitrary origin would let a
    // malicious site read authenticated responses.
    const response = await request(app)
      .get('/api/v1/health/live')
      .set('Origin', 'https://evil.example.com');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
