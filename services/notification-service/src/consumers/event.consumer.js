import { TOPICS, EVENTS, createEvent, prefixedId, createLogger } from '@streaming/shared';
import { render } from '../domain/templates.js';

const log = createLogger('notification-service:consumer');

/**
 * notification-service subscribes to several topics at once.
 *
 * It is the clearest example of why events beat direct calls: user, subscription
 * and playback services have no idea this service exists. Adding a new
 * notification means adding a template here — no other service changes.
 */
export function registerNotificationConsumers({ bus, repo, deliver }) {
  const topics = [TOPICS.USER_EVENTS, TOPICS.SUBSCRIPTION_EVENTS, TOPICS.PLAYBACK_EVENTS];

  return Promise.all(
    topics.map((topic) =>
      bus.subscribe(
        topic,
        async (event) => {
          const fresh = await repo.markEventProcessed(event.eventId, 'notifications');
          if (!fresh) {
            log.debug({ eventId: event.eventId }, 'duplicate event — skipping');
            return;
          }

          const rendered = render(event);
          if (!rendered) return; // not a notifiable event

          const userId = event.payload.userId;
          if (!userId) return;

          const notification = await repo.create({
            id: prefixedId('ntf'),
            user_id: userId,
            channel: rendered.channel,
            category: rendered.category,
            subject: rendered.subject,
            body: rendered.body,
            source_event_id: event.eventId,
            source_event_type: event.type,
            created_at: new Date().toISOString()
          });

          // Actually sending (SES/FCM/Twilio) is a pluggable side effect.
          await deliver(notification);

          await bus.publish(
            TOPICS.NOTIFICATION_EVENTS,
            createEvent(
              EVENTS.NOTIFICATION_SENT,
              { notificationId: notification.id, userId, channel: rendered.channel, category: rendered.category },
              { key: userId, correlationId: event.correlationId, causationId: event.eventId }
            )
          );

          log.info({ userId, channel: rendered.channel, subject: rendered.subject }, 'notification created');
        },
        { groupId: 'notifications' }
      )
    )
  );
}

/**
 * Default delivery: log it. Swapping in a real provider is a one-line change,
 * which is the point of keeping it behind this function.
 */
export async function consoleDeliver(notification) {
  log.info(
    { to: notification.user_id, channel: notification.channel, subject: notification.subject },
    'delivering notification'
  );
}
