import { createApp, config, getCache, serviceClient } from '@streaming/shared';
import { createRecommendationRouter } from './routes/recommendation.routes.js';
import { createVocabulary } from './domain/vocabulary.js';

/**
 * recommendation-service — natural-language search over the catalog.
 *
 * It owns no database of its own: it composes catalog-service and
 * watch-history-service, and caches aggressively in Redis.
 */
export function createRecommendationApp({
  cache = getCache(),
  catalogClient = serviceClient(config.services.catalog, 'catalog-service'),
  historyClient = serviceClient(config.services.watchHistory, 'watch-history-service'),
  vocabulary
} = {}) {
  const vocab = vocabulary || createVocabulary({ catalogClient });

  return createApp({
    service: 'recommendation-service',
    checks: {
      cache: async () => Boolean(await cache.ping()),
      catalog: async () => {
        try {
          await catalogClient.get('/health');
          return true;
        } catch {
          return false;
        }
      }
    },
    routes: [
      { path: '/recommendations', router: createRecommendationRouter({ cache, catalogClient, historyClient, vocabulary: vocab }) }
    ]
  });
}
