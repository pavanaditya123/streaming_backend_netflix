import { createApp, config, postgres } from '@streaming/shared';
import { createAuthRouter, createUserRouter } from './routes/auth.routes.js';
import { createUserRepo } from './repo/index.js';

/**
 * user-service — owns identity: registration, login, JWT issuance, profiles.
 *
 * Dependencies are arguments, not imports, so tests build the app with
 * in-memory adapters and no network at all.
 */
export function createUserApp({ repo = createUserRepo(), bus } = {}) {
  return createApp({
    service: 'user-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [
      // Public: the caller has no token yet.
      { path: '/auth', router: createAuthRouter({ repo, bus }) },
      // Guarded inside the router: requires the internal secret + forwarded identity.
      { path: '/users', router: createUserRouter({ repo }) }
    ]
  });
}
