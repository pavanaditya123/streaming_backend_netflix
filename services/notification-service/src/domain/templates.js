import { EVENTS } from '@streaming/shared';

const rupees = (minor) => `₹${(minor / 100).toFixed(2)}`;

/**
 * One template per event type the platform can notify about.
 *
 * Returning `null` means "this event is not worth notifying about" — which is
 * how the consumer stays quiet about the high-volume playback events.
 */
export const TEMPLATES = {
  [EVENTS.USER_REGISTERED]: (p) => ({
    channel: 'email',
    category: 'account',
    subject: 'Welcome to the platform 🎬',
    body: `Hi ${p.displayName}, your account is ready. Pick a plan and start watching.`
  }),

  [EVENTS.SUBSCRIPTION_ACTIVATED]: (p) => ({
    channel: 'email',
    category: 'billing',
    subject: `Your ${p.planName} plan is active`,
    body:
      `You're subscribed to ${p.planName} (${rupees(p.priceMinor)}/month). ` +
      `Stream on up to ${p.maxStreams} device(s) in ${p.maxQuality}. ` +
      `Renews on ${new Date(p.currentPeriodEnd).toDateString()}.`
  }),

  [EVENTS.SUBSCRIPTION_FAILED]: (p) => ({
    channel: 'email',
    category: 'billing',
    subject: 'We could not activate your subscription',
    body: reasonText(p.reason)
  }),

  [EVENTS.SUBSCRIPTION_CANCELLED]: (p) => ({
    channel: 'email',
    category: 'billing',
    subject: 'Your subscription is cancelled',
    body: `Your ${p.planId} plan has been cancelled. You can resubscribe any time.`
  }),

  [EVENTS.PLAYBACK_STOPPED]: (p) =>
    // Only celebrate finishing something; ignore every partial stop.
    p.completed
      ? {
          channel: 'push',
          category: 'engagement',
          subject: `You finished ${p.titleName || 'a title'}`,
          body: 'Nice one. Here are some things you might enjoy next.'
        }
      : null
};

function reasonText(reason) {
  switch (reason) {
    case 'card_declined':
      return 'Your card was declined. Please try a different payment method.';
    case 'limit_exceeded':
      return 'The amount exceeded your card limit. Try a different card or a cheaper plan.';
    case 'payment_timeout':
      return 'The payment timed out and no money was taken. Please try again.';
    case 'activation_failed_refunded':
      return 'Something went wrong on our side, so we refunded you in full. Please try again.';
    default:
      return 'Something went wrong while activating your subscription. No money was taken.';
  }
}

/** Build a notification for an event, or null if it should not produce one. */
export function render(event) {
  const template = TEMPLATES[event.type];
  if (!template) return null;
  return template(event.payload);
}

export const NOTIFIABLE_EVENTS = Object.keys(TEMPLATES);
