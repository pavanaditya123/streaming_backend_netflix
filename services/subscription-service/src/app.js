import { createApp, config, postgres, getCache } from '@streaming/shared';
import { createSubscriptionRouter } from './routes/subscription.routes.js';
import { createSubscriptionRepo } from './repo/index.js';
import { SubscribeSagaOrchestrator } from './saga/orchestrator.js';
import { registerBillingReplyConsumer } from './consumers/billing.consumer.js';

/**
 * subscription-service — owns plans, subscriptions, entitlement, and is the
 * ORCHESTRATOR of the Subscribe Saga.
 */
export function createSubscriptionApp({ repo = createSubscriptionRepo(), cache = getCache(), bus } = {}) {
  const orchestrator = new SubscribeSagaOrchestrator({ repo, bus, cache });

  if (bus) registerBillingReplyConsumer({ bus, repo, orchestrator });

  const app = createApp({
    service: 'subscription-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      cache: async () => Boolean(await cache.ping()),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [{ path: '/subscriptions', router: createSubscriptionRouter({ repo, bus, cache, orchestrator }) }]
  });

  app.locals.orchestrator = orchestrator;
  app.locals.repo = repo;
  return app;
}
