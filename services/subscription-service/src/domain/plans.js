/** Subscription plans. Prices are in paise (smallest currency unit) — never floats for money. */
export const PLANS = {
  basic: {
    id: 'basic',
    name: 'Basic',
    priceMinor: 14900,
    currency: 'INR',
    maxStreams: 1,
    maxQuality: '480p',
    downloads: false
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    priceMinor: 49900,
    currency: 'INR',
    maxStreams: 2,
    maxQuality: '1080p',
    downloads: true
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    priceMinor: 64900,
    currency: 'INR',
    maxStreams: 4,
    maxQuality: '4K',
    downloads: true
  }
};

export const PLAN_IDS = Object.keys(PLANS);

export const getPlan = (id) => PLANS[id] || null;

export const formatMinor = (minor, currency = 'INR') =>
  `${currency} ${(minor / 100).toFixed(2)}`;

/** Billing period end for a monthly plan, computed from a start date. */
export function periodEnd(startISO, months = 1) {
  const d = new Date(startISO);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}
