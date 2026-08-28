import { TOPICS, EVENTS, cacheKeys, createLogger } from '@streaming/shared';

const log = createLogger('catalog-service:consumer');

/**
 * Catalog keeps its own popularity counter by consuming playback events.
 *
 * This is the core of the "decoupling" story: playback-service does not call
 * catalog-service to bump a counter — it publishes a fact, and every interested
 * service reacts on its own schedule. Playback stays fast and stays up even if
 * catalog is down.
 */
export function registerPlaybackConsumer({ bus, repo, cache }) {
  return bus.subscribe(
    TOPICS.PLAYBACK_EVENTS,
    async (event) => {
      if (event.type !== EVENTS.PLAYBACK_STARTED) return;

      const { titleId } = event.payload;
      const updated = await repo.incrementViews(titleId, 1);
      if (!updated) {
        log.warn({ titleId }, 'playback for unknown title — ignoring');
        return;
      }

      // The counter changed, so the cached title and every trending list are stale.
      await cache.del(cacheKeys.title(titleId));
      await cache.delByPattern(cacheKeys.trending());
    },
    { groupId: 'catalog-popularity', types: [EVENTS.PLAYBACK_STARTED] }
  );
}
