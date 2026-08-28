import { TOPICS, EVENTS, cacheKeys, createLogger } from '@streaming/shared';

const log = createLogger('watch-history-service:consumer');

/**
 * watch-history-service is written entirely around the event stream — it has no
 * synchronous dependency on playback-service at all.
 *
 * This is the decoupling win: playback answers the user in milliseconds and
 * publishes a fact; history is built here, asynchronously, and a slow or failed
 * write here never delays or breaks someone's stream.
 */
export function registerPlaybackConsumer({ bus, repo, cache }) {
  return bus.subscribe(
    TOPICS.PLAYBACK_EVENTS,
    async (event) => {
      // Kafka is at-least-once, so the same event can arrive twice. Dedupe on
      // eventId before mutating anything.
      const fresh = await repo.markEventProcessed(event.eventId, 'watch-history');
      if (!fresh) {
        log.debug({ eventId: event.eventId }, 'duplicate playback event — skipping');
        return;
      }

      const { userId, titleId, titleName } = event.payload;
      const watchedAt = event.occurredAt;

      switch (event.type) {
        case EVENTS.PLAYBACK_STARTED:
          await repo.incrementPlayCount({
            userId, titleId, titleName,
            durationSeconds: event.payload.durationSeconds,
            watchedAt
          });
          break;

        case EVENTS.PLAYBACK_PROGRESS:
          await repo.upsertProgress({
            userId, titleId, titleName,
            positionSeconds: event.payload.positionSeconds,
            durationSeconds: event.payload.durationSeconds,
            completed: false,
            watchedAt
          });
          break;

        case EVENTS.PLAYBACK_STOPPED:
          await repo.upsertProgress({
            userId, titleId, titleName,
            positionSeconds: event.payload.positionSeconds,
            durationSeconds: event.payload.durationSeconds,
            completed: event.payload.completed,
            watchedAt
          });
          break;

        default:
          return;
      }

      // The user's history just changed, so their cached rows are stale.
      await cache.del(cacheKeys.continueWatching(userId));
      await cache.delByPattern(`wh:list:${userId}:`);
    },
    {
      groupId: 'watch-history',
      types: [EVENTS.PLAYBACK_STARTED, EVENTS.PLAYBACK_PROGRESS, EVENTS.PLAYBACK_STOPPED]
    }
  );
}
