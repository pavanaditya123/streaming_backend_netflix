/**
 * Subscribe Saga — pure state machine.
 *
 * WHY A SAGA: activating a subscription spans two services (subscription +
 * billing) and two databases. There is no distributed transaction across them,
 * so instead we run a sequence of local transactions, and if a later step fails
 * we run *compensating* actions to undo the earlier ones.
 *
 * This module is deliberately pure — no database, no Kafka, no clock. Given a
 * state and an event it returns the next state plus the commands to emit. That
 * makes every branch, including the compensation paths, unit-testable without
 * any infrastructure.
 */

import { EVENTS } from '@streaming/shared';

export const SAGA_STATES = {
  STARTED: 'STARTED',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  ACTIVATING: 'ACTIVATING',
  COMPENSATING_REFUND: 'COMPENSATING_REFUND',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

export const TERMINAL_STATES = [SAGA_STATES.COMPLETED, SAGA_STATES.FAILED];

export const isTerminal = (state) => TERMINAL_STATES.includes(state);

/** Command names the orchestrator knows how to execute. */
export const COMMANDS = {
  CHARGE_PAYMENT: 'CHARGE_PAYMENT',
  ACTIVATE_SUBSCRIPTION: 'ACTIVATE_SUBSCRIPTION',
  REFUND_PAYMENT: 'REFUND_PAYMENT',
  MARK_FAILED: 'MARK_FAILED',
  PUBLISH_ACTIVATED: 'PUBLISH_ACTIVATED',
  PUBLISH_FAILED: 'PUBLISH_FAILED'
};

/**
 * Kick the saga off.
 * Local step (create a pending subscription) has already happened by this point.
 */
export function start() {
  return {
    state: SAGA_STATES.AWAITING_PAYMENT,
    commands: [{ type: COMMANDS.CHARGE_PAYMENT }]
  };
}

/**
 * The whole saga in one function: (currentState, event) -> { state, commands }.
 *
 * Returning `commands` rather than performing side effects is what keeps this
 * testable; the orchestrator is the only part that touches the outside world.
 */
export function transition(currentState, event) {
  const { type, payload = {} } = event;

  switch (currentState) {
    case SAGA_STATES.AWAITING_PAYMENT: {
      if (type === EVENTS.CHARGE_SUCCEEDED) {
        return {
          state: SAGA_STATES.ACTIVATING,
          commands: [{ type: COMMANDS.ACTIVATE_SUBSCRIPTION, paymentId: payload.paymentId }]
        };
      }
      if (type === EVENTS.CHARGE_FAILED) {
        // Nothing was charged, so there is nothing to compensate — fail directly.
        return {
          state: SAGA_STATES.FAILED,
          commands: [
            { type: COMMANDS.MARK_FAILED, reason: payload.reason || 'payment_failed' },
            { type: COMMANDS.PUBLISH_FAILED, reason: payload.reason || 'payment_failed' }
          ]
        };
      }
      return ignore(currentState, type);
    }

    case SAGA_STATES.ACTIVATING: {
      if (type === 'ACTIVATION_SUCCEEDED') {
        return {
          state: SAGA_STATES.COMPLETED,
          commands: [{ type: COMMANDS.PUBLISH_ACTIVATED }]
        };
      }
      if (type === 'ACTIVATION_FAILED') {
        // Money has already moved. Compensate by refunding it.
        return {
          state: SAGA_STATES.COMPENSATING_REFUND,
          commands: [{ type: COMMANDS.REFUND_PAYMENT, reason: payload.reason || 'activation_failed' }]
        };
      }
      return ignore(currentState, type);
    }

    case SAGA_STATES.COMPENSATING_REFUND: {
      if (type === EVENTS.REFUND_COMPLETED) {
        return {
          state: SAGA_STATES.FAILED,
          commands: [
            { type: COMMANDS.MARK_FAILED, reason: 'activation_failed_refunded' },
            { type: COMMANDS.PUBLISH_FAILED, reason: 'activation_failed_refunded' }
          ]
        };
      }
      return ignore(currentState, type);
    }

    // A terminal saga ignores everything: late duplicates must not resurrect it.
    case SAGA_STATES.COMPLETED:
    case SAGA_STATES.FAILED:
      return { state: currentState, commands: [], ignored: true, reason: 'saga already terminal' };

    default:
      return ignore(currentState, type);
  }
}

function ignore(state, type) {
  return { state, commands: [], ignored: true, reason: `no transition for ${type} in ${state}` };
}

/** Human-readable description used by the /sagas debug endpoint and the docs. */
export const SAGA_GRAPH = [
  ['STARTED', 'AWAITING_PAYMENT', 'subscribe requested -> CHARGE_PAYMENT'],
  ['AWAITING_PAYMENT', 'ACTIVATING', 'billing.charge.succeeded'],
  ['AWAITING_PAYMENT', 'FAILED', 'billing.charge.failed (no compensation needed)'],
  ['ACTIVATING', 'COMPLETED', 'activation ok -> subscription.activated'],
  ['ACTIVATING', 'COMPENSATING_REFUND', 'activation error -> REFUND_PAYMENT'],
  ['COMPENSATING_REFUND', 'FAILED', 'billing.refund.completed -> subscription.failed']
];
