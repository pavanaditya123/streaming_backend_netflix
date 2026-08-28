/**
 * Pure playback authorisation rules.
 *
 * Kept separate from the HTTP/Redis code so every rule is unit-testable, and so
 * "why was I blocked?" has exactly one answer in exactly one place.
 */

export const DENY = {
  NO_SUBSCRIPTION: 'no_active_subscription',
  PLAN_NOT_ENTITLED: 'title_not_in_plan',
  STREAM_LIMIT: 'max_concurrent_streams_reached',
  MATURITY: 'maturity_restricted'
};

/** Quality ladder, lowest to highest. A plan caps the ladder. */
export const QUALITY_LADDER = ['480p', '720p', '1080p', '4K'];

export function allowedQualities(maxQuality) {
  const cap = QUALITY_LADDER.indexOf(maxQuality);
  return cap === -1 ? ['480p'] : QUALITY_LADDER.slice(0, cap + 1);
}

/**
 * @param entitlement  from subscription-service: { entitled, planId, maxStreams, maxQuality }
 * @param title        from catalog-service: { plans, maturity }
 * @param activeStreams how many sessions this user already has open
 * @param profile      optional { isKid: boolean }
 */
export function authorizePlayback({ entitlement, title, activeStreams = 0, profile = {} }) {
  if (!entitlement?.entitled) {
    return { allowed: false, reason: DENY.NO_SUBSCRIPTION, message: 'An active subscription is required' };
  }

  if (!title.plans.includes(entitlement.planId)) {
    return {
      allowed: false,
      reason: DENY.PLAN_NOT_ENTITLED,
      message: `"${title.title}" is not included in the ${entitlement.planId} plan`,
      upgradeTo: title.plans[title.plans.length - 1]
    };
  }

  if (profile.isKid && title.maturity !== 'U') {
    return { allowed: false, reason: DENY.MATURITY, message: 'This title is not available on a kids profile' };
  }

  if (activeStreams >= entitlement.maxStreams) {
    return {
      allowed: false,
      reason: DENY.STREAM_LIMIT,
      message: `Your ${entitlement.planId} plan allows ${entitlement.maxStreams} concurrent stream(s)`,
      activeStreams,
      maxStreams: entitlement.maxStreams
    };
  }

  return {
    allowed: true,
    quality: entitlement.maxQuality,
    availableQualities: allowedQualities(entitlement.maxQuality)
  };
}

/** Resume point: ignore a position that is essentially the start or the end. */
export function resumePosition(positionSeconds, durationSeconds) {
  if (!positionSeconds || positionSeconds < 30) return 0;
  if (durationSeconds && positionSeconds > durationSeconds * 0.95) return 0;
  return Math.floor(positionSeconds);
}

/** A title counts as "completed" once the viewer passes 90% of it. */
export function isCompleted(positionSeconds, durationSeconds) {
  if (!durationSeconds) return false;
  return positionSeconds >= durationSeconds * 0.9;
}
