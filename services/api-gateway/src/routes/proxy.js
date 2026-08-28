import { Router } from 'express';
import { asyncHandler, callService, config } from '@streaming/shared';

/**
 * Generic reverse proxy for one downstream service.
 *
 * The gateway is the ONLY place that validates the end-user JWT. Downstream it
 * forwards the identity as headers plus the shared internal secret, so no
 * service ever has to re-verify a token, and none of them are reachable from
 * outside with a forged identity.
 */
export function proxyRouter({ baseUrl, serviceName, prefix = '' }) {
  const router = Router();

  router.all(
    /.*/,
    asyncHandler(async (req, res) => {
      const path = `${prefix}${req.path === '/' ? '' : req.path}`;
      const qs = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';

      const { status, body } = await callService(baseUrl, `${path}${qs}`, {
        method: req.method,
        body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : req.body,
        user: req.user,
        requestId: req.id,
        serviceName,
        timeoutMs: 5000,
        raw: true,
        headers: req.headers['idempotency-key']
          ? { 'idempotency-key': req.headers['idempotency-key'] }
          : {}
      });

      // Pass the owning service's status code straight through: 201 for a
      // created session, 202 for a saga that is still running, 204 for a delete.
      // The gateway routes; it does not reinterpret what a service decided.
      if (status === 204 || body === null) {
        res.status(204).end();
        return;
      }
      res.status(status).json(body);
    })
  );

  return router;
}

export const upstreams = () => ({
  user: { baseUrl: config.services.user, serviceName: 'user-service' },
  catalog: { baseUrl: config.services.catalog, serviceName: 'catalog-service' },
  playback: { baseUrl: config.services.playback, serviceName: 'playback-service' },
  watchHistory: { baseUrl: config.services.watchHistory, serviceName: 'watch-history-service' },
  subscription: { baseUrl: config.services.subscription, serviceName: 'subscription-service' },
  billing: { baseUrl: config.services.billing, serviceName: 'billing-service' },
  notification: { baseUrl: config.services.notification, serviceName: 'notification-service' },
  recommendation: { baseUrl: config.services.recommendation, serviceName: 'recommendation-service' }
});
