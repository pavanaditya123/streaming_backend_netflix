/**
 * Every Kafka topic and event type in the platform, in one file.
 *
 * Naming: `<aggregate>.<events|commands>` for topics, `<aggregate>.<thing>.<past-tense>`
 * for event types. Commands are directed at one service; events are facts anyone may consume.
 */
export const TOPICS = {
  PLAYBACK_EVENTS: 'playback.events',
  SUBSCRIPTION_EVENTS: 'subscription.events',
  BILLING_COMMANDS: 'billing.commands',
  BILLING_EVENTS: 'billing.events',
  USER_EVENTS: 'user.events',
  NOTIFICATION_EVENTS: 'notification.events',
  DEAD_LETTER: 'platform.dlq'
};

export const EVENTS = {
  // playback.events
  PLAYBACK_STARTED: 'playback.session.started',
  PLAYBACK_PROGRESS: 'playback.session.progress',
  PLAYBACK_STOPPED: 'playback.session.stopped',

  // subscription.events
  SUBSCRIPTION_REQUESTED: 'subscription.requested',
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_FAILED: 'subscription.failed',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',

  // billing.commands  (orchestrator -> billing)
  CHARGE_REQUESTED: 'billing.charge.requested',
  REFUND_REQUESTED: 'billing.refund.requested',

  // billing.events    (billing -> orchestrator)
  CHARGE_SUCCEEDED: 'billing.charge.succeeded',
  CHARGE_FAILED: 'billing.charge.failed',
  REFUND_COMPLETED: 'billing.refund.completed',

  // user.events
  USER_REGISTERED: 'user.registered',

  // notification.events
  NOTIFICATION_SENT: 'notification.sent'
};

export const ALL_TOPICS = Object.values(TOPICS);
