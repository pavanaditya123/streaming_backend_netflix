import express, { Router } from 'express';
import { fileURLToPath } from 'node:url';
import {
  createApp, getCache, authenticate, rateLimit,
  asyncHandler, callService, breakerStates
} from '@streaming/shared';
import { proxyRouter, upstreams } from './routes/proxy.js';
import { createHomeRouter, createClients } from './routes/home.route.js';

/**
 * api-gateway — the only service exposed to the public internet.
 *
 * Responsibilities (and deliberately nothing else — no business logic lives here):
 *   - terminate the public API surface at /api/v1
 *   - verify the end-user JWT exactly once
 *   - rate limit
 *   - route to the owning service
 *   - compose the home screen (BFF)
 */
export function createGatewayApp({ cache = getCache(), clients = createClients() } = {}) {
  const up = upstreams();
  const api = Router();

  // ---- public: no token required ----------------------------------------
  api.use('/auth', rateLimit({ cache, limit: 20, windowSeconds: 60, keyFn: (req) => `auth:${req.ip}` }));
  api.use('/auth', proxyRouter({ ...up.user, prefix: '/auth' }));

  api.get(
    '/plans',
    asyncHandler(async (req, res) => {
      res.json(await callService(up.subscription.baseUrl, '/subscriptions/plans', {
        requestId: req.id,
        serviceName: up.subscription.serviceName
      }));
    })
  );

  // ---- everything below requires a valid JWT -----------------------------
  api.use(authenticate);
  api.use(rateLimit({ cache, limit: 300, windowSeconds: 60 }));

  api.use('/home', createHomeRouter({ cache, clients }));
  api.use('/me', proxyRouter({ ...up.user, prefix: '/users/me' }));
  api.use('/titles', proxyRouter({ ...up.catalog, prefix: '/titles' }));
  api.use('/playback', proxyRouter({ ...up.playback, prefix: '/playback' }));
  api.use('/watch-history', proxyRouter({ ...up.watchHistory, prefix: '/watch-history' }));
  api.use('/subscriptions', proxyRouter({ ...up.subscription, prefix: '/subscriptions' }));
  api.use('/billing', proxyRouter({ ...up.billing, prefix: '/billing' }));
  api.use('/notifications', proxyRouter({ ...up.notification, prefix: '/notifications' }));
  api.use('/recommendations', proxyRouter({ ...up.recommendation, prefix: '/recommendations' }));

  const ops = Router();

  /** Aggregated readiness across the whole platform — one call for a dashboard. */
  ops.get(
    '/services',
    asyncHandler(async (req, res) => {
      const entries = Object.entries(up);
      const results = await Promise.all(
        entries.map(async ([name, { baseUrl, serviceName }]) => {
          try {
            const health = await callService(baseUrl, '/health/ready', {
              requestId: req.id, serviceName, timeoutMs: 2000, retries: 0
            });
            return [name, { status: health.status, dependencies: health.dependencies }];
          } catch (err) {
            return [name, { status: 'unreachable', error: err.message }];
          }
        })
      );
      const services = Object.fromEntries(results);
      const allUp = Object.values(services).every((s) => s.status === 'ready');
      res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : 'degraded', services, circuitBreakers: breakerStates() });
    })
  );

  return createApp({
    service: 'api-gateway',
    checks: { cache: async () => Boolean(await cache.ping()) },
    routes: [
      { path: '/api/v1', router: api },
      { path: '/ops', router: ops },
      { path: '/', router: express.static(fileURLToPath(new URL('../public/', import.meta.url)), {
        setHeaders(res) {
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'same-origin');
        }
      }) }
    ]
  });
}
