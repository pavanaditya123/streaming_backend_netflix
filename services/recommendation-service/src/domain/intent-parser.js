import {
  GENRE_SYNONYMS, MOOD_SYNONYMS, LANGUAGE_SYNONYMS,
  COUNTRY_SYNONYMS, AWARD_SYNONYMS, STOPWORDS
} from './lexicon.js';

/**
 * Rule-based natural-language intent parser.
 *
 * WHY RULES AND NOT AN LLM: this runs on the hot path of a search box. Rules are
 * sub-millisecond, deterministic, free, work offline, and — most importantly —
 * every branch is unit-testable. An LLM would add hundreds of milliseconds and
 * make the results non-reproducible. The trade-off is vocabulary coverage, which
 * is why the vocabulary lives in lexicon.js as data.
 *
 * The parser returns the FIRST matching intent, so `INTENTS` is ordered most
 * specific first: "korean horror movies from the 90s" must not be swallowed by
 * the generic `by_genre` rule.
 */

export const normalize = (q) =>
  String(q || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const has = (q, ...phrases) => phrases.some((p) => q.includes(p));

/**
 * Find which key of a synonym map the query mentions.
 *
 * When several synonyms match, the LONGEST one wins: "space station documentary"
 * mentions both "space" (sci-fi) and "documentary", and the longer, more
 * specific word is the better read of what the user meant.
 */
function lookup(map, q) {
  let best = null;
  for (const [key, synonyms] of Object.entries(map)) {
    for (const syn of synonyms) {
      // Word-boundary match so "action" does not fire inside "transaction".
      const re = new RegExp(`(^|\\s)${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s)?($|\\s)`);
      if (re.test(q) && (!best || syn.length > best.matched.length)) {
        best = { key, matched: syn };
      }
    }
  }
  return best;
}

const genreOf = (q) => lookup(GENRE_SYNONYMS, q);
const moodOf = (q) => lookup(MOOD_SYNONYMS, q);
const languageOf = (q) => lookup(LANGUAGE_SYNONYMS, q);
const countryOf = (q) => lookup(COUNTRY_SYNONYMS, q);
const awardOf = (q) => lookup(AWARD_SYNONYMS, q);

/** movie vs series, when the query says so. */
function typeOf(q) {
  if (has(q, 'series', 'show', 'shows', 'tv', 'season', 'seasons', 'episodes', 'binge', 'sitcom', 'k drama', 'kdrama'))
    return 'series';
  if (has(q, 'movie', 'movies', 'film', 'films', 'cinema')) return 'movie';
  return null;
}

/** Explicit year (1980-2029) anywhere in the query. */
function yearOf(q) {
  const m = q.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  return m ? Number(m[1]) : null;
}

/** "90s", "1990s", "2000s" -> a year range. */
function decadeOf(q) {
  const m = q.match(/\b(?:(19|20)(\d0)s|(\d0)s)\b/);
  if (!m) return null;
  let start;
  if (m[1]) start = Number(`${m[1]}${m[2]}`);
  else {
    const two = Number(m[3]);
    start = two >= 50 ? 1900 + two : 2000 + two;
  }
  return { yearFrom: start, yearTo: start + 9, label: `${start}s` };
}

/** "rated above 8", "at least 8.5", "8+" */
function ratingThresholdOf(q) {
  const m = q.match(/(?:rated|rating|score|above|over|better than|at least|more than)\s*(?:above|over|than)?\s*(\d(?:\.\d)?)/)
    || q.match(/\b(\d(?:\.\d)?)\s*\+/)
    || q.match(/\b(\d(?:\.\d)?)\s*(?:stars?|out of 10|\/10)\b/);
  if (!m) return null;
  const value = Number(m[1]);
  return value >= 1 && value <= 10 ? value : null;
}

/** "under 90 minutes", "less than 2 hours" */
function maxDurationOf(q) {
  const mins = q.match(/(?:under|less than|below|shorter than|within|max)\s*(\d{2,3})\s*(?:min|mins|minutes)/);
  if (mins) return Number(mins[1]);
  const hours = q.match(/(?:under|less than|below|shorter than|within|max)\s*(\d(?:\.\d)?)\s*(?:hour|hours|hr|hrs)/);
  if (hours) return Math.round(Number(hours[1]) * 60);
  return null;
}

function minDurationOf(q) {
  const mins = q.match(/(?:over|more than|longer than|at least|above)\s*(\d{2,3})\s*(?:min|mins|minutes)/);
  if (mins) return Number(mins[1]);
  const hours = q.match(/(?:over|more than|longer than|at least|above)\s*(\d(?:\.\d)?)\s*(?:hour|hours|hr|hrs)/);
  if (hours) return Math.round(Number(hours[1]) * 60);
  return null;
}

const PLAN_RE = /\b(basic|standard|premium)\b/;

/**
 * Match a known title mentioned in the query.
 * Longest title first, so "The Dark Knight" wins over a title called "Dark".
 */
function titleRefOf(q, titles = []) {
  const sorted = [...titles].sort((a, b) => b.title.length - a.title.length);
  for (const t of sorted) {
    const name = normalize(t.title);
    if (name.length >= 3 && q.includes(name)) return t;
  }
  return null;
}

/** Free-text left over once the intent words are stripped. */
function residual(q) {
  return q
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ')
    .trim();
}

/**
 * The intent table. Each entry: { name, describe, match(query, ctx) -> slots|null }
 * Ordered from most specific to most general.
 */
export const INTENTS = [
  {
    name: 'continue_watching',
    describe: 'Resume something already started',
    match: (q) =>
      has(q, 'continue watching', 'continue', 'resume', 'where did i leave', 'where i left',
             'was i watching', 'am i watching', 'pick up where')
        ? { personalized: true }
        : null
  },
  {
    name: 'unfinished',
    describe: 'Titles started but never finished',
    match: (q) =>
      has(q, 'finish what i started', 'unfinished', 'not finished', "didn't finish", 'did not finish',
             'half watched', 'incomplete')
        ? { personalized: true }
        : null
  },
  {
    name: 'most_watched_by_me',
    describe: "The user's own most-replayed titles",
    match: (q) =>
      has(q, 'watch the most', 'most watched', 'i watch most', 'my favourites', 'my favorites', 'rewatch')
        ? { personalized: true }
        : null
  },
  {
    name: 'because_you_watched',
    describe: 'Personalised from viewing history',
    match: (q, ctx) => {
      if (!has(q, 'because i watched', 'since i watched', 'since i liked', 'based on my', 'for me',
                 'recommend me', 'recommendations for me', 'what should i watch'))
        return null;
      const ref = titleRefOf(q, ctx.titles);
      return { personalized: true, seedTitleId: ref?.id, seedTitle: ref?.title };
    }
  },
  {
    name: 'similar_to',
    describe: 'More titles like a specific one',
    match: (q, ctx) => {
      if (!has(q, 'like', 'similar to', 'same as', 'more of', 'in the style of', 'reminds me of')) return null;
      const ref = titleRefOf(q, ctx.titles);
      return ref ? { seedTitleId: ref.id, seedTitle: ref.title } : null;
    }
  },
  {
    name: 'by_director',
    describe: 'Titles from a specific director',
    match: (q, ctx) => {
      const m = q.match(/(?:directed by|director|by the director|from the director(?: of)?)\s+([a-z' -]{3,40})/);
      if (m) return { person: m[1].trim(), role: 'director' };
      // "nolan movies" / "tarantino films"
      const known = ctx.directors?.find((d) => {
        const last = normalize(d).split(' ').pop();
        return last.length > 3 && new RegExp(`(^|\\s)${last}($|\\s)`).test(q);
      });
      return known ? { person: known, role: 'director' } : null;
    }
  },
  {
    name: 'by_actor',
    describe: 'Titles featuring a specific actor',
    match: (q, ctx) => {
      const m = q.match(/(?:starring|with|featuring|acted by|movies of|films of)\s+([a-z' .-]{3,40})/);
      if (m) {
        const candidate = m[1].trim();
        const known = ctx.actors?.find((a) => normalize(a).includes(candidate) || candidate.includes(normalize(a)));
        if (known) return { person: known, role: 'actor' };
      }
      const known = ctx.actors?.find((a) => q.includes(normalize(a)));
      return known ? { person: known, role: 'actor' } : null;
    }
  },
  {
    name: 'award_winning',
    describe: 'Award winners',
    match: (q) => {
      const award = awardOf(q);
      if (!award && !has(q, 'award winning', 'award-winning', 'critically acclaimed', 'acclaimed')) return null;
      return { award: award?.key, genre: genreOf(q)?.key, type: typeOf(q) };
    }
  },
  {
    name: 'included_in_plan',
    describe: 'What a given plan tier includes',
    match: (q) => {
      if (!has(q, 'plan', 'subscription', 'tier', 'included in', 'can i watch on')) return null;
      const m = q.match(PLAN_RE);
      return m ? { plan: m[1] } : null;
    }
  },
  {
    name: 'popular_in_region',
    describe: 'Popular in a country',
    match: (q) => {
      if (!has(q, 'popular in', 'trending in', 'top in', 'watched in', 'hit in')) return null;
      const country = countryOf(q);
      return country ? { country: country.key } : null;
    }
  },
  {
    name: 'family_friendly',
    describe: 'Safe for children',
    match: (q) =>
      has(q, 'kids', 'children', 'child', 'family friendly', 'family-friendly', 'safe for', 'with my family',
             'for my kid', 'for my son', 'for my daughter', 'all ages')
        ? { maturity: 'U', type: typeOf(q) }
        : null
  },
  {
    name: 'short_content',
    describe: 'Something short',
    match: (q) => {
      const max = maxDurationOf(q);
      if (max) return { maxDuration: max, type: typeOf(q), genre: genreOf(q)?.key };
      if (has(q, 'short movie', 'something short', 'quick watch', 'quick', "don't have much time",
                 'do not have much time', 'short film'))
        return { maxDuration: 100, type: typeOf(q), genre: genreOf(q)?.key };
      return null;
    }
  },
  {
    name: 'long_content',
    describe: 'Something long / epic',
    match: (q) => {
      const min = minDurationOf(q);
      if (min) return { minDuration: min, type: typeOf(q), genre: genreOf(q)?.key };
      if (has(q, 'lengthy', 'epic length', 'three hour', '3 hour') || /\blong\b.*\b(movie|film|watch)\b/.test(q))
        return { minDuration: 150, type: typeOf(q), genre: genreOf(q)?.key };
      return null;
    }
  },
  {
    name: 'by_rating_threshold',
    describe: 'Above a rating cut-off',
    match: (q) => {
      const minRating = ratingThresholdOf(q);
      if (!minRating) return null;
      // A query can carry several constraints at once ("90s movies rated above
      // 8"). Whichever intent fires, it keeps the other slots rather than
      // silently dropping them.
      const decade = decadeOf(q);
      return {
        minRating,
        genre: genreOf(q)?.key,
        type: typeOf(q),
        language: languageOf(q)?.key,
        yearFrom: decade?.yearFrom,
        yearTo: decade?.yearTo
      };
    }
  },
  {
    name: 'binge_series',
    describe: 'A series to binge',
    match: (q) =>
      has(q, 'binge', 'series to watch', 'tv series', 'web series', 'show to watch', 'next series')
        ? { type: 'series', genre: genreOf(q)?.key, language: languageOf(q)?.key }
        : null
  },
  {
    name: 'by_decade',
    describe: 'From a decade',
    match: (q) => {
      const decade = decadeOf(q);
      if (!decade) return null;
      return {
        ...decade,
        genre: genreOf(q)?.key,
        type: typeOf(q),
        language: languageOf(q)?.key,
        minRating: ratingThresholdOf(q) ?? undefined
      };
    }
  },
  {
    name: 'new_releases',
    describe: 'Recently added / newest',
    match: (q) => {
      if (!has(q, 'new release', 'new releases', 'newest', 'latest', 'recently added', 'just added',
                  'this year', 'came out recently', 'recent'))
        return null;
      return { sort: 'recent', genre: genreOf(q)?.key, type: typeOf(q), language: languageOf(q)?.key };
    }
  },
  {
    name: 'trending_now',
    describe: 'What everyone is watching',
    match: (q) =>
      has(q, 'trending', 'popular', 'everyone is watching', 'hot right now', "what's hot", 'whats hot',
             'top charts', 'most popular', 'buzzing')
        ? { sort: 'popularity', genre: genreOf(q)?.key, type: typeOf(q) }
        : null
  },
  {
    name: 'top_rated',
    describe: 'Highest rated',
    match: (q) =>
      has(q, 'top rated', 'highest rated', 'best rated', 'best', 'greatest', 'must watch', 'must-watch',
             'critically best', 'all time')
        ? { sort: 'rating', minRating: 8, genre: genreOf(q)?.key, type: typeOf(q), language: languageOf(q)?.key }
        : null
  },
  {
    name: 'by_year',
    describe: 'From a specific year',
    match: (q) => {
      const year = yearOf(q);
      if (!year) return null;
      return { year, genre: genreOf(q)?.key, type: typeOf(q), language: languageOf(q)?.key };
    }
  },
  {
    name: 'by_genre_and_language',
    describe: 'Genre combined with a language',
    match: (q) => {
      const genre = genreOf(q);
      const language = languageOf(q);
      if (!genre || !language) return null;
      return { genre: genre.key, language: language.key, type: typeOf(q) };
    }
  },
  {
    name: 'by_mood',
    describe: 'Match a mood rather than a genre',
    match: (q) => {
      const mood = moodOf(q);
      if (!mood) return null;
      return { mood: mood.key, type: typeOf(q), language: languageOf(q)?.key };
    }
  },
  {
    name: 'by_language',
    describe: 'In a specific language',
    match: (q) => {
      const language = languageOf(q);
      if (!language) return null;
      return { language: language.key, type: typeOf(q), genre: genreOf(q)?.key };
    }
  },
  {
    name: 'by_genre',
    describe: 'A plain genre browse',
    match: (q) => {
      const genre = genreOf(q);
      if (!genre) return null;
      return { genre: genre.key, type: typeOf(q) };
    }
  },
  {
    name: 'random_pick',
    describe: 'Just pick something',
    match: (q) =>
      has(q, 'surprise me', 'random', 'anything', 'i dont care', "i don't care", 'you choose', 'pick for me',
             'whatever')
        ? { random: true }
        : null
  },
  {
    name: 'by_title_search',
    describe: 'Fallback keyword search over the catalog',
    match: (q) => {
      const text = residual(q);
      return text.length >= 2 ? { q: text } : null;
    }
  }
];

export const INTENT_NAMES = INTENTS.map((i) => i.name);

/**
 * Parse a natural-language query into { intent, slots }.
 *
 * @param query raw user text
 * @param ctx   { titles, actors, directors } — vocabulary drawn from the catalog
 */
export function parseIntent(query, ctx = {}) {
  const q = normalize(query);
  const context = { titles: [], actors: [], directors: [], ...ctx };

  if (!q) {
    return { intent: 'trending_now', slots: { sort: 'popularity' }, confidence: 0.3, query: q, fallback: true };
  }

  for (const intent of INTENTS) {
    const slots = intent.match(q, context);
    if (slots) {
      // Drop undefined slots so the shape stays clean for the cache key.
      const clean = Object.fromEntries(Object.entries(slots).filter(([, v]) => v !== undefined && v !== null));
      return {
        intent: intent.name,
        describe: intent.describe,
        slots: clean,
        confidence: intent.name === 'by_title_search' ? 0.4 : 0.9,
        query: q,
        fallback: intent.name === 'by_title_search'
      };
    }
  }

  return { intent: 'trending_now', slots: { sort: 'popularity' }, confidence: 0.2, query: q, fallback: true };
}
