import {
  TOPICS, EVENTS, createEvent, prefixedId, cacheKeys,
  createLogger, metrics, ConflictError, NotFoundError
} from '@streaming/shared';
import { SAGA_STATES, COMMANDS, start, transition, isTerminal } from '../domain/saga-definition.js';
import { getPlan, periodEnd } from '../domain/plans.js';

const log = createLogger('subscription-service:saga');

/**
 * Subscribe Saga orchestrator.
 *
 * The orchestrator owns the *decision* (which service acts next); each
 * participant owns its own data. The pure state machine in
 * domain/saga-definition.js decides the next state and the commands; this class
 * executes those commands against the database, the cache and the event bus.
 */
export class SubscribeSagaOrchestrator {
  constructor({ repo, bus, cache }) {
    this.repo = repo;
    this.bus = bus;
    this.cache = cache;
  }

  /** Step 1 (local transaction): create a pending subscription and its saga. */
  async begin({ userId, planId, paymentMethod, correlationId }) {
    const plan = getPlan(planId);
    if (!plan) throw new NotFoundError(`Unknown plan: ${planId}`);

    const existing = await this.repo.findActiveByUser(userId);
    if (existing) {
      throw new ConflictError('User already has an active subscription', {
        subscriptionId: existing.id,
        planId: existing.plan_id
      });
    }

    const now = new Date().toISOString();
    const subscriptionId = prefixedId('sub');
    const sagaId = prefixedId('saga');

    await this.repo.createSubscription({
      id: subscriptionId,
      user_id: userId,
      plan_id: plan.id,
      status: 'pending',
      price_minor: plan.priceMinor,
      currency: plan.currency,
      current_period_start: now,
      current_period_end: periodEnd(now),
      created_at: now
    });

    const { state, commands } = start();

    await this.repo.createSaga({
      id: sagaId,
      saga_type: 'SUBSCRIBE',
      subscription_id: subscriptionId,
      user_id: userId,
      state,
      payload: { planId: plan.id, priceMinor: plan.priceMinor, currency: plan.currency, paymentMethod, correlationId },
      history: [{ at: now, from: SAGA_STATES.STARTED, to: state, trigger: 'subscribe.requested' }],
      created_at: now
    });

    metrics.sagaTransitions.inc({ saga: 'SUBSCRIBE', to: state });
    log.info({ sagaId, subscriptionId, userId, planId: plan.id }, 'saga started');

    await this.#execute(sagaId, commands);

    return { subscriptionId, sagaId, state, planId: plan.id, status: 'pending' };
  }

  /**
   * Feed an event (from billing, or one we raised ourselves) into the saga.
   * Loads state, asks the state machine what to do, persists, then executes.
   */
  async handle(sagaId, event) {
    const saga = await this.repo.findSaga(sagaId);
    if (!saga) {
      log.warn({ sagaId, type: event.type }, 'event for unknown saga — ignoring');
      return null;
    }

    if (isTerminal(saga.state)) {
      log.info({ sagaId, state: saga.state, type: event.type }, 'saga already terminal — ignoring');
      return saga;
    }

    const result = transition(saga.state, event);

    if (result.ignored) {
      log.warn({ sagaId, state: saga.state, type: event.type, reason: result.reason }, 'no transition');
      return saga;
    }

    await this.repo.updateSaga(sagaId, { state: result.state });
    await this.repo.appendSagaHistory(sagaId, {
      at: new Date().toISOString(),
      from: saga.state,
      to: result.state,
      trigger: event.type
    });

    metrics.sagaTransitions.inc({ saga: 'SUBSCRIBE', to: result.state });
    if (isTerminal(result.state)) metrics.sagaCompleted.inc({ saga: 'SUBSCRIBE', outcome: result.state });

    log.info({ sagaId, from: saga.state, to: result.state, trigger: event.type }, 'saga transition');

    await this.#execute(sagaId, result.commands, event);
    return this.repo.findSaga(sagaId);
  }

  /** Turn the state machine's commands into real side effects. */
  async #execute(sagaId, commands, sourceEvent) {
    const saga = await this.repo.findSaga(sagaId);
    if (!saga) return;

    for (const command of commands) {
      switch (command.type) {
        case COMMANDS.CHARGE_PAYMENT:
          await this.#chargePayment(saga);
          break;

        case COMMANDS.ACTIVATE_SUBSCRIPTION:
          await this.#activate(saga, command.paymentId);
          break;

        case COMMANDS.REFUND_PAYMENT:
          await this.#refund(saga, command.reason);
          break;

        case COMMANDS.MARK_FAILED:
          await this.repo.updateSubscription(saga.subscription_id, {
            status: 'failed',
            failure_reason: command.reason
          });
          break;

        case COMMANDS.PUBLISH_ACTIVATED:
          await this.#publishActivated(saga);
          break;

        case COMMANDS.PUBLISH_FAILED:
          await this.bus.publish(
            TOPICS.SUBSCRIPTION_EVENTS,
            createEvent(
              EVENTS.SUBSCRIPTION_FAILED,
              {
                subscriptionId: saga.subscription_id,
                userId: saga.user_id,
                planId: saga.payload.planId,
                reason: command.reason
              },
              { key: saga.user_id, correlationId: saga.payload.correlationId, causationId: sourceEvent?.eventId }
            )
          );
          break;

        default:
          log.error({ command }, 'unknown saga command');
      }
    }
  }

  /** Command -> billing-service. A command is addressed to one service. */
  async #chargePayment(saga) {
    await this.bus.publish(
      TOPICS.BILLING_COMMANDS,
      createEvent(
        EVENTS.CHARGE_REQUESTED,
        {
          sagaId: saga.id,
          subscriptionId: saga.subscription_id,
          userId: saga.user_id,
          amountMinor: saga.payload.priceMinor,
          currency: saga.payload.currency,
          paymentMethod: saga.payload.paymentMethod,
          // Billing dedupes on this, so a redelivered command never double-charges.
          idempotencyKey: `charge:${saga.id}`
        },
        { key: saga.user_id, correlationId: saga.payload.correlationId }
      )
    );
  }

  /**
   * Local step: flip the subscription to active and warm the entitlement cache.
   * If anything here throws, we feed ACTIVATION_FAILED back into the saga, which
   * triggers the refund compensation.
   */
  async #activate(saga, paymentId) {
    // Record the payment id on the SAGA before attempting activation.
    // If activation then fails, compensation needs to know what to refund — and
    // it cannot read it from the subscription row, because that is exactly the
    // write that just failed. The saga's own state is the source of truth.
    await this.repo.updateSaga(saga.id, { payload: { ...saga.payload, paymentId } });

    try {
      const now = new Date().toISOString();
      await this.repo.updateSubscription(saga.subscription_id, {
        status: 'active',
        payment_id: paymentId,
        current_period_start: now,
        current_period_end: periodEnd(now)
      });

      // Entitlement is read on every playback request, so it lives in Redis.
      await this.cache.del(cacheKeys.entitlement(saga.user_id));

      await this.handle(saga.id, { type: 'ACTIVATION_SUCCEEDED', payload: { paymentId } });
    } catch (err) {
      log.error({ sagaId: saga.id, err: err.message }, 'activation failed — compensating');
      await this.handle(saga.id, { type: 'ACTIVATION_FAILED', payload: { reason: err.message } });
    }
  }

  /** Compensating action: ask billing to give the money back. */
  async #refund(saga, reason) {
    const subscription = await this.repo.findSubscription(saga.subscription_id);
    // Prefer the id the saga recorded at charge time; the subscription row may
    // never have been updated if that is what failed.
    const paymentId = saga.payload.paymentId || subscription?.payment_id;

    if (!paymentId) {
      log.error({ sagaId: saga.id }, 'cannot compensate: no payment id recorded');
    }

    await this.bus.publish(
      TOPICS.BILLING_COMMANDS,
      createEvent(
        EVENTS.REFUND_REQUESTED,
        {
          sagaId: saga.id,
          subscriptionId: saga.subscription_id,
          userId: saga.user_id,
          paymentId,
          amountMinor: saga.payload.priceMinor,
          currency: saga.payload.currency,
          reason,
          idempotencyKey: `refund:${saga.id}`
        },
        { key: saga.user_id, correlationId: saga.payload.correlationId }
      )
    );
  }

  async #publishActivated(saga) {
    const subscription = await this.repo.findSubscription(saga.subscription_id);
    const plan = getPlan(saga.payload.planId);

    await this.bus.publish(
      TOPICS.SUBSCRIPTION_EVENTS,
      createEvent(
        EVENTS.SUBSCRIPTION_ACTIVATED,
        {
          subscriptionId: saga.subscription_id,
          userId: saga.user_id,
          planId: plan.id,
          planName: plan.name,
          maxStreams: plan.maxStreams,
          maxQuality: plan.maxQuality,
          priceMinor: plan.priceMinor,
          currency: plan.currency,
          currentPeriodEnd: subscription?.current_period_end
        },
        { key: saga.user_id, correlationId: saga.payload.correlationId }
      )
    );
  }
}

/** Timeout sweeper: a saga stuck awaiting payment must not hang forever. */
export async function sweepStalledSagas({ repo, orchestrator, timeoutMs = 30_000, now = Date.now() }) {
  const sagas = await repo.listSagas({ limit: 200 });
  let swept = 0;

  for (const saga of sagas) {
    if (isTerminal(saga.state)) continue;
    const age = now - new Date(saga.updated_at || saga.created_at).getTime();
    if (age < timeoutMs) continue;

    log.warn({ sagaId: saga.id, state: saga.state, ageMs: age }, 'saga timed out');
    if (saga.state === SAGA_STATES.AWAITING_PAYMENT) {
      await orchestrator.handle(saga.id, {
        type: EVENTS.CHARGE_FAILED,
        payload: { reason: 'payment_timeout' }
      });
      swept += 1;
    }
  }
  return swept;
}

