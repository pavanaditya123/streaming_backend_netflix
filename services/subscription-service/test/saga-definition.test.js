import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '@streaming/shared';
import {
  SAGA_STATES, COMMANDS, start, transition, isTerminal, SAGA_GRAPH
} from '../src/domain/saga-definition.js';

/**
 * The saga state machine is pure, so every branch — including the compensation
 * paths that are hard to trigger for real — is tested here with no database,
 * no Kafka and no clock.
 */
describe('Subscribe saga state machine', () => {
  test('starts by asking billing to charge', () => {
    const { state, commands } = start();
    assert.equal(state, SAGA_STATES.AWAITING_PAYMENT);
    assert.deepEqual(commands, [{ type: COMMANDS.CHARGE_PAYMENT }]);
  });

  describe('happy path', () => {
    test('a successful charge moves to ACTIVATING', () => {
      const result = transition(SAGA_STATES.AWAITING_PAYMENT, {
        type: EVENTS.CHARGE_SUCCEEDED,
        payload: { paymentId: 'pay_1' }
      });
      assert.equal(result.state, SAGA_STATES.ACTIVATING);
      assert.deepEqual(result.commands, [
        { type: COMMANDS.ACTIVATE_SUBSCRIPTION, paymentId: 'pay_1' }
      ]);
    });

    test('a successful activation completes the saga', () => {
      const result = transition(SAGA_STATES.ACTIVATING, { type: 'ACTIVATION_SUCCEEDED', payload: {} });
      assert.equal(result.state, SAGA_STATES.COMPLETED);
      assert.deepEqual(result.commands, [{ type: COMMANDS.PUBLISH_ACTIVATED }]);
    });
  });

  describe('payment failure — nothing to compensate', () => {
    test('a declined charge fails the saga directly', () => {
      const result = transition(SAGA_STATES.AWAITING_PAYMENT, {
        type: EVENTS.CHARGE_FAILED,
        payload: { reason: 'card_declined' }
      });
      assert.equal(result.state, SAGA_STATES.FAILED);
      assert.deepEqual(result.commands.map((c) => c.type), [
        COMMANDS.MARK_FAILED,
        COMMANDS.PUBLISH_FAILED
      ]);
      assert.equal(result.commands[0].reason, 'card_declined');
    });

    test('no refund is issued, because no money moved', () => {
      const result = transition(SAGA_STATES.AWAITING_PAYMENT, {
        type: EVENTS.CHARGE_FAILED,
        payload: { reason: 'card_declined' }
      });
      assert.ok(
        !result.commands.some((c) => c.type === COMMANDS.REFUND_PAYMENT),
        'refunding an uncharged card would be a bug'
      );
    });
  });

  describe('COMPENSATION — activation fails after the money moved', () => {
    test('a failed activation triggers a refund', () => {
      const result = transition(SAGA_STATES.ACTIVATING, {
        type: 'ACTIVATION_FAILED',
        payload: { reason: 'db_down' }
      });
      assert.equal(result.state, SAGA_STATES.COMPENSATING_REFUND);
      assert.deepEqual(result.commands, [{ type: COMMANDS.REFUND_PAYMENT, reason: 'db_down' }]);
    });

    test('a completed refund closes the saga as FAILED', () => {
      const result = transition(SAGA_STATES.COMPENSATING_REFUND, {
        type: EVENTS.REFUND_COMPLETED,
        payload: { refundId: 'ref_1' }
      });
      assert.equal(result.state, SAGA_STATES.FAILED);
      assert.deepEqual(result.commands.map((c) => c.type), [
        COMMANDS.MARK_FAILED,
        COMMANDS.PUBLISH_FAILED
      ]);
      assert.equal(result.commands[0].reason, 'activation_failed_refunded');
    });

    test('the full compensation path runs end to end', () => {
      let state = start().state;
      state = transition(state, { type: EVENTS.CHARGE_SUCCEEDED, payload: { paymentId: 'p1' } }).state;
      state = transition(state, { type: 'ACTIVATION_FAILED', payload: {} }).state;
      state = transition(state, { type: EVENTS.REFUND_COMPLETED, payload: {} }).state;

      assert.equal(state, SAGA_STATES.FAILED);
      assert.ok(isTerminal(state));
    });
  });

  describe('idempotency and safety', () => {
    test('a terminal saga ignores late duplicate events', () => {
      for (const terminal of [SAGA_STATES.COMPLETED, SAGA_STATES.FAILED]) {
        const result = transition(terminal, { type: EVENTS.CHARGE_SUCCEEDED, payload: {} });
        assert.equal(result.state, terminal, 'a finished saga must never restart');
        assert.deepEqual(result.commands, []);
        assert.equal(result.ignored, true);
      }
    });

    test('an event that makes no sense in the current state is ignored, not crashed on', () => {
      const result = transition(SAGA_STATES.AWAITING_PAYMENT, {
        type: EVENTS.REFUND_COMPLETED,
        payload: {}
      });
      assert.equal(result.ignored, true);
      assert.deepEqual(result.commands, []);
      assert.equal(result.state, SAGA_STATES.AWAITING_PAYMENT, 'state is unchanged');
    });

    test('a duplicate charge success does not re-activate', () => {
      const first = transition(SAGA_STATES.AWAITING_PAYMENT, {
        type: EVENTS.CHARGE_SUCCEEDED, payload: { paymentId: 'p1' }
      });
      const duplicate = transition(first.state, {
        type: EVENTS.CHARGE_SUCCEEDED, payload: { paymentId: 'p1' }
      });
      assert.equal(duplicate.ignored, true);
      assert.deepEqual(duplicate.commands, [], 'must not activate twice');
    });

    test('only COMPLETED and FAILED are terminal', () => {
      assert.ok(isTerminal(SAGA_STATES.COMPLETED));
      assert.ok(isTerminal(SAGA_STATES.FAILED));
      assert.ok(!isTerminal(SAGA_STATES.AWAITING_PAYMENT));
      assert.ok(!isTerminal(SAGA_STATES.ACTIVATING));
      assert.ok(!isTerminal(SAGA_STATES.COMPENSATING_REFUND));
    });
  });

  test('the documented graph matches the implemented transitions', () => {
    // Guards against the docs and the code drifting apart.
    const documented = new Set(SAGA_GRAPH.map(([from, to]) => `${from}->${to}`));
    assert.ok(documented.has('AWAITING_PAYMENT->ACTIVATING'));
    assert.ok(documented.has('AWAITING_PAYMENT->FAILED'));
    assert.ok(documented.has('ACTIVATING->COMPLETED'));
    assert.ok(documented.has('ACTIVATING->COMPENSATING_REFUND'));
    assert.ok(documented.has('COMPENSATING_REFUND->FAILED'));
  });
});
