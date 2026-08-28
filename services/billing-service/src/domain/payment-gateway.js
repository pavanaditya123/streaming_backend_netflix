import { prefixedId, config } from '@streaming/shared';

/**
 * Simulated payment gateway.
 *
 * A real integration (Stripe/Razorpay) would live behind this same interface.
 * Failures are *deterministic* rather than random so the saga's compensation
 * path can be demonstrated and tested reliably:
 *
 *   - a card number ending in the configured suffix always declines
 *   - amounts above a threshold always decline (spend limit)
 *   - `paymentMethod.forceFail` declines on demand
 */
export async function charge({ amountMinor, currency, paymentMethod = {} }) {
  const card = String(paymentMethod.cardNumber || '');

  if (paymentMethod.forceFail) {
    return decline('card_declined', 'Card was declined by the issuer');
  }
  if (card.endsWith(config.billing.failForCardSuffix)) {
    return decline('card_declined', `Cards ending in ${config.billing.failForCardSuffix} are declined`);
  }
  if (amountMinor > config.billing.failOnAmountAbove) {
    return decline('limit_exceeded', 'Amount exceeds the spending limit on this card');
  }
  if (amountMinor <= 0) {
    return decline('invalid_amount', 'Amount must be positive');
  }

  return {
    ok: true,
    paymentId: prefixedId('pay'),
    amountMinor,
    currency,
    processedAt: new Date().toISOString()
  };
}

export async function refund({ paymentId, amountMinor, currency }) {
  if (!paymentId) return decline('unknown_payment', 'No payment to refund');
  return {
    ok: true,
    refundId: prefixedId('ref'),
    paymentId,
    amountMinor,
    currency,
    processedAt: new Date().toISOString()
  };
}

function decline(reason, message) {
  return { ok: false, reason, message };
}
