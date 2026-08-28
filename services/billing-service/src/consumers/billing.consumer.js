import { TOPICS, EVENTS, createEvent, prefixedId, createLogger } from '@streaming/shared';
import { charge, refund } from '../domain/payment-gateway.js';

const log = createLogger('billing-service:consumer');

/**
 * billing-service is a *saga participant*: it listens for commands, performs a
 * local transaction, and replies with an event. It never decides what happens
 * next — that is the orchestrator's job.
 */
export function registerBillingConsumers({ bus, repo }) {
  return bus.subscribe(
    TOPICS.BILLING_COMMANDS,
    async (event) => {
      // Kafka delivers at-least-once. Dedupe before doing anything with money.
      const fresh = await repo.markEventProcessed(event.eventId, 'billing-commands');
      if (!fresh) {
        log.info({ eventId: event.eventId, type: event.type }, 'duplicate command — skipping');
        return;
      }

      if (event.type === EVENTS.CHARGE_REQUESTED) await handleCharge({ bus, repo, event });
      else if (event.type === EVENTS.REFUND_REQUESTED) await handleRefund({ bus, repo, event });
    },
    { groupId: 'billing-commands', types: [EVENTS.CHARGE_REQUESTED, EVENTS.REFUND_REQUESTED] }
  );
}

async function handleCharge({ bus, repo, event }) {
  const { sagaId, subscriptionId, userId, amountMinor, currency, paymentMethod, idempotencyKey } = event.payload;

  // Second safety net: even a *different* command asking for the same logical
  // charge reuses the original outcome rather than charging twice.
  const existing = await repo.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    log.info({ idempotencyKey, paymentId: existing.id }, 'charge already processed — replaying result');
    await replyToCharge({ bus, event, payment: existing });
    return;
  }

  const result = await charge({ amountMinor, currency, paymentMethod });
  const paymentId = result.ok ? result.paymentId : prefixedId('pay');

  const payment = await repo.createPayment({
    id: paymentId,
    user_id: userId,
    subscription_id: subscriptionId,
    saga_id: sagaId,
    idempotency_key: idempotencyKey,
    amount_minor: amountMinor,
    currency,
    status: result.ok ? 'succeeded' : 'failed',
    failure_reason: result.ok ? null : result.reason,
    created_at: new Date().toISOString()
  });

  log.info({ sagaId, paymentId, status: payment.status, amountMinor }, 'charge processed');
  await replyToCharge({ bus, event, payment });
}

async function replyToCharge({ bus, event, payment }) {
  const succeeded = payment.status === 'succeeded';
  await bus.publish(
    TOPICS.BILLING_EVENTS,
    createEvent(
      succeeded ? EVENTS.CHARGE_SUCCEEDED : EVENTS.CHARGE_FAILED,
      {
        sagaId: event.payload.sagaId,
        subscriptionId: event.payload.subscriptionId,
        userId: event.payload.userId,
        paymentId: payment.id,
        amountMinor: payment.amount_minor,
        currency: payment.currency,
        reason: payment.failure_reason || undefined
      },
      { key: event.payload.userId, correlationId: event.correlationId, causationId: event.eventId }
    )
  );
}

async function handleRefund({ bus, repo, event }) {
  const { sagaId, subscriptionId, userId, paymentId, amountMinor, currency, reason } = event.payload;

  const result = await refund({ paymentId, amountMinor, currency });
  if (paymentId) {
    await repo.updatePayment(paymentId, {
      status: 'refunded',
      refund_id: result.refundId,
      failure_reason: reason
    });
  }

  log.info({ sagaId, paymentId, refundId: result.refundId }, 'refund processed');

  await bus.publish(
    TOPICS.BILLING_EVENTS,
    createEvent(
      EVENTS.REFUND_COMPLETED,
      { sagaId, subscriptionId, userId, paymentId, refundId: result.refundId, amountMinor, currency, reason },
      { key: userId, correlationId: event.correlationId, causationId: event.eventId }
    )
  );
}
