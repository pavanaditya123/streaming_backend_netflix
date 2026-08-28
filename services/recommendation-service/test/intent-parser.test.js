import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, INTENTS, INTENT_NAMES, normalize } from '../src/domain/intent-parser.js';
import { TITLES } from '../../../db/seed/titles.js';

// Vocabulary drawn from the real catalog, exactly as the service does at runtime.
const ctx = {
  titles: TITLES.map((t) => ({ id: t.id, title: t.title })),
  actors: [...new Set(TITLES.flatMap((t) => t.cast || []))],
  directors: [...new Set(TITLES.map((t) => t.director).filter(Boolean))]
};

const intentOf = (q) => parseIntent(q, ctx).intent;
const slotsOf = (q) => parseIntent(q, ctx).slots;

describe('intent parser', () => {
  test('supports at least 20 distinct intents', () => {
    assert.ok(INTENT_NAMES.length >= 20, `only ${INTENT_NAMES.length} intents`);
    assert.equal(new Set(INTENT_NAMES).size, INTENT_NAMES.length, 'intent names must be unique');
  });

  test('every intent declares a human-readable description', () => {
    for (const intent of INTENTS) {
      assert.ok(intent.describe && intent.describe.length > 5, `${intent.name} needs a description`);
    }
  });

  describe('classification', () => {
    const cases = [
      ['what was I watching', 'continue_watching'],
      ['continue watching', 'continue_watching'],
      ['where did I leave off', 'continue_watching'],
      ['finish what I started', 'unfinished'],
      ['what do I watch the most', 'most_watched_by_me'],
      ['because I watched Breaking Bad', 'because_you_watched'],
      ['something like Inception', 'similar_to'],
      ['more of The Matrix', 'similar_to'],
      ['films directed by Christopher Nolan', 'by_director'],
      ['movies with Tom Hanks', 'by_actor'],
      ['oscar winning dramas', 'award_winning'],
      ['what can I watch on the basic plan', 'included_in_plan'],
      ['popular in India', 'popular_in_region'],
      ['kids movies', 'family_friendly'],
      ['safe for children', 'family_friendly'],
      ['something under 90 minutes', 'short_content'],
      ['movies under 2 hours', 'short_content'],
      ['a long epic movie', 'long_content'],
      ['movies rated above 8', 'by_rating_threshold'],
      ['a series to binge', 'binge_series'],
      ['90s movies', 'by_decade'],
      ['new releases', 'new_releases'],
      ['what is trending', 'trending_now'],
      ['best movies of all time', 'top_rated'],
      ['comedy movies from 2019', 'by_year'],
      ['korean thriller series', 'by_genre_and_language'],
      ['something funny to cheer me up', 'by_mood'],
      ['hindi movies', 'by_language'],
      ['action movies', 'by_genre'],
      ['surprise me', 'random_pick']
    ];

    for (const [query, expected] of cases) {
      test(`"${query}" -> ${expected}`, () => {
        assert.equal(intentOf(query), expected);
      });
    }
  });

  describe('slot extraction', () => {
    test('pulls a genre and a language out of one query', () => {
      assert.deepEqual(slotsOf('korean thriller series'), {
        genre: 'thriller', language: 'ko', type: 'series'
      });
    });

    test('converts a decade into a year range', () => {
      const slots = slotsOf('90s action movies');
      assert.equal(slots.yearFrom, 1990);
      assert.equal(slots.yearTo, 1999);
      assert.equal(slots.genre, 'action');
    });

    test('keeps BOTH constraints when a query has a decade and a rating', () => {
      const slots = slotsOf('90s movies rated above 8');
      assert.equal(slots.minRating, 8);
      assert.equal(slots.yearFrom, 1990);
      assert.equal(slots.yearTo, 1999);
    });

    test('understands hours as well as minutes', () => {
      assert.equal(slotsOf('movies under 2 hours').maxDuration, 120);
      assert.equal(slotsOf('something under 90 minutes').maxDuration, 90);
    });

    test('resolves a real title mentioned in the query', () => {
      const slots = slotsOf('something like Inception');
      assert.equal(slots.seedTitleId, 'tt_inception');
      assert.equal(slots.seedTitle, 'Inception');
    });

    test('prefers the longest title match', () => {
      // "Dark" is a real title; "The Dark Knight" must still win.
      assert.equal(slotsOf('more like The Dark Knight').seedTitleId, 'tt_dark_knight');
    });

    test('prefers the most specific vocabulary word', () => {
      // "space" maps to sci-fi and "documentary" to documentary; the longer,
      // more specific word should win.
      assert.equal(slotsOf('space station documentary').genre, 'documentary');
    });

    test('distinguishes movies from series', () => {
      assert.equal(slotsOf('action movies').type, 'movie');
      assert.equal(slotsOf('action shows').type, 'series');
    });

    test('resolves a known actor without a "starring" keyword', () => {
      assert.equal(slotsOf('Tom Hanks').person, 'Tom Hanks');
    });
  });

  describe('robustness', () => {
    test('is case and punctuation insensitive', () => {
      assert.equal(intentOf('ACTION MOVIES!!!'), 'by_genre');
      assert.equal(intentOf('  action   movies  '), 'by_genre');
    });

    test('falls back to keyword search for an unrecognised query', () => {
      const parsed = parseIntent('zqxwv nonsense phrase', ctx);
      assert.equal(parsed.intent, 'by_title_search');
      assert.equal(parsed.fallback, true);
      assert.ok(parsed.confidence < 0.5, 'a fallback should report low confidence');
    });

    test('falls back to trending for an empty query', () => {
      const parsed = parseIntent('', ctx);
      assert.equal(parsed.intent, 'trending_now');
      assert.equal(parsed.fallback, true);
    });

    test('never throws, whatever it is given', () => {
      for (const input of [null, undefined, '', '???', '12345', 'a'.repeat(500), '🎬🎬🎬']) {
        assert.doesNotThrow(() => parseIntent(input, ctx));
      }
    });

    test('works with no catalog vocabulary available', () => {
      // If catalog-service is down the vocabulary is empty; parsing must degrade,
      // not crash.
      assert.doesNotThrow(() => parseIntent('something like Inception', {}));
      assert.equal(parseIntent('action movies', {}).intent, 'by_genre');
    });

    test('is fast enough for a search box', () => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 1000; i += 1) parseIntent('korean thriller series from the 90s', ctx);
      const msPerParse = Number(process.hrtime.bigint() - started) / 1e6 / 1000;
      assert.ok(msPerParse < 2, `parse took ${msPerParse.toFixed(3)}ms, expected under 2ms`);
    });
  });

  test('normalize strips punctuation and collapses whitespace', () => {
    assert.equal(normalize('  Hello,   WORLD!! '), 'hello world');
  });
});
