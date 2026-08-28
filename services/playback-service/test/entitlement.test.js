import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizePlayback, allowedQualities, resumePosition, isCompleted, DENY
} from '../src/domain/entitlement.js';

const premium = { entitled: true, planId: 'premium', maxStreams: 4, maxQuality: '4K' };
const basic = { entitled: true, planId: 'basic', maxStreams: 1, maxQuality: '480p' };

const title = (over = {}) => ({
  id: 't1', title: 'Test Title', plans: ['basic', 'standard', 'premium'], maturity: 'UA', ...over
});

describe('playback authorization', () => {
  test('allows a subscribed user to play an included title', () => {
    const d = authorizePlayback({ entitlement: premium, title: title(), activeStreams: 0 });
    assert.equal(d.allowed, true);
    assert.equal(d.quality, '4K');
  });

  test('blocks a user with no active subscription', () => {
    const d = authorizePlayback({ entitlement: { entitled: false }, title: title(), activeStreams: 0 });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, DENY.NO_SUBSCRIPTION);
  });

  test('blocks a title that is not in the user plan, and suggests an upgrade', () => {
    const d = authorizePlayback({
      entitlement: basic,
      title: title({ plans: ['premium'] }),
      activeStreams: 0
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, DENY.PLAN_NOT_ENTITLED);
    assert.equal(d.upgradeTo, 'premium');
  });

  test('enforces the concurrent-stream limit at exactly the plan maximum', () => {
    const under = authorizePlayback({ entitlement: premium, title: title(), activeStreams: 3 });
    const at = authorizePlayback({ entitlement: premium, title: title(), activeStreams: 4 });
    assert.equal(under.allowed, true, '3 of 4 streams is still allowed');
    assert.equal(at.allowed, false, 'the 5th concurrent stream is blocked');
    assert.equal(at.reason, DENY.STREAM_LIMIT);
    assert.equal(at.maxStreams, 4);
  });

  test('a basic plan allows exactly one stream', () => {
    assert.equal(authorizePlayback({ entitlement: basic, title: title(), activeStreams: 0 }).allowed, true);
    assert.equal(authorizePlayback({ entitlement: basic, title: title(), activeStreams: 1 }).allowed, false);
  });

  test('blocks mature content on a kids profile', () => {
    const d = authorizePlayback({
      entitlement: premium,
      title: title({ maturity: 'A' }),
      activeStreams: 0,
      profile: { isKid: true }
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, DENY.MATURITY);
  });

  test('allows U-rated content on a kids profile', () => {
    const d = authorizePlayback({
      entitlement: premium,
      title: title({ maturity: 'U' }),
      activeStreams: 0,
      profile: { isKid: true }
    });
    assert.equal(d.allowed, true);
  });

  test('checks subscription before anything else', () => {
    // No subscription AND over the stream limit -> the subscription is the
    // message the user should see.
    const d = authorizePlayback({
      entitlement: { entitled: false },
      title: title({ plans: ['premium'] }),
      activeStreams: 99
    });
    assert.equal(d.reason, DENY.NO_SUBSCRIPTION);
  });
});

describe('quality ladder', () => {
  test('caps the ladder at the plan maximum', () => {
    assert.deepEqual(allowedQualities('480p'), ['480p']);
    assert.deepEqual(allowedQualities('1080p'), ['480p', '720p', '1080p']);
    assert.deepEqual(allowedQualities('4K'), ['480p', '720p', '1080p', '4K']);
  });

  test('degrades safely for an unknown quality', () => {
    assert.deepEqual(allowedQualities('8K'), ['480p']);
  });
});

describe('resume position', () => {
  test('ignores a position in the first 30 seconds', () => {
    assert.equal(resumePosition(10, 6000), 0);
    assert.equal(resumePosition(29, 6000), 0);
  });

  test('resumes from a real mid-title position', () => {
    assert.equal(resumePosition(1800, 6000), 1800);
  });

  test('restarts a title that was essentially finished', () => {
    assert.equal(resumePosition(5900, 6000), 0, 'past 95% means start over');
  });
});

describe('completion', () => {
  test('counts as completed past 90%', () => {
    assert.equal(isCompleted(5400, 6000), true);
    assert.equal(isCompleted(5399, 6000), false);
  });

  test('is never completed without a known duration', () => {
    assert.equal(isCompleted(5400, 0), false);
    assert.equal(isCompleted(5400, undefined), false);
  });
});
