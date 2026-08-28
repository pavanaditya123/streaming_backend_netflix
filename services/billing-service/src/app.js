import { createApp, config, postgres } from '@streaming/shared';
import { createBillingRouter } from './routes/billing.routes.js';
import { createBillingRepo } from './repo/index.js';
import { registerBillingConsumers } from './consumers/billing.consumer.js';

/**
 * billing-service — saga participant. Its real work happens on the event bus
 * (charge/refund commands); the HTTP surface is only for reading payment history.
 */
export function createBillingApp({ repo = createBillingRepo(), bus } = {}) {
  if (bus) registerBillingConsumers({ bus, repo });

  return createApp({
    service: 'billing-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [{ path: '/billing', router: createBillingRouter({ repo }) }]
  });
}
