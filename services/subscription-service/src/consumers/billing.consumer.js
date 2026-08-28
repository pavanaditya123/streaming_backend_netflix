import { TOPICS, EVENTS, createLogger } from '@streaming/shared';

const log = createLogger('subscription-service:billing-consumer');

/**
 * Billing's replies come back here and are fed into the saga.
 *
 * The orchestrator is a consumer like any other — that is what makes the whole
 * flow asynchronous and crash-tolerant: if this service restarts mid-saga, the
 * saga row is still in Postgres and the reply is still on the topic.
 */
export function registerBillingReplyConsumer({ bus, repo, orchestrator }) {
  return bus.subscribe(
    TOPICS.BILLING_EVENTS,
    async (event) => {
      const fresh = await repo.markEventProcessed(event.eventId, 'saga-billing-replies');
      if (!fresh) {
        log.info({ eventId: event.eventId }, 'duplicate billing reply — skipping');
        return;
      }

      const { sagaId } = event.payload;
      if (!sagaId) return;

      await orchestrator.handle(sagaId, event);
    },
    {
      groupId: 'subscription-saga',
      types: [EVENTS.CHARGE_SUCCEEDED, EVENTS.CHARGE_FAILED, EVENTS.REFUND_COMPLETED]
    }
  );
}
