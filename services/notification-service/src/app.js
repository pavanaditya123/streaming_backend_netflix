import { createApp, config, postgres } from '@streaming/shared';
import { createNotificationRouter } from './routes/notification.routes.js';
import { createNotificationRepo } from './repo/index.js';
import { registerNotificationConsumers, consoleDeliver } from './consumers/event.consumer.js';

/**
 * notification-service — a pure event consumer. It fans in from user,
 * subscription and playback topics and fans out to email/push.
 */
export function createNotificationApp({
  repo = createNotificationRepo(),
  bus,
  deliver = consoleDeliver
} = {}) {
  if (bus) registerNotificationConsumers({ bus, repo, deliver });

  const app = createApp({
    service: 'notification-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [{ path: '/notifications', router: createNotificationRouter({ repo }) }]
  });

  app.locals.repo = repo;
  return app;
}
