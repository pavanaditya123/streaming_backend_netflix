/**
 * Turns a parsed intent into catalog queries.
 *
 * The parser answers "what did they mean?"; the resolver answers "what do I
 * fetch, and in what order do I rank it?". Keeping them apart means the parser
 * can be tested with zero I/O, and the ranking can change without touching NLP.
 */

/** Intents that need the user's own watch history to answer. */
export const PERSONALIZED_INTENTS = new Set([
  'continue_watching',
  'unfinished',
  'most_watched_by_me',
  'because_you_watched'
]);

/** Map intent slots onto catalog-service query parameters. */
export function toCatalogQuery(slots = {}, { limit = 12 } = {}) {
  const params = new URLSearchParams();
  const put = (k, v) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  };

  put('genre', slots.genre);
  put('mood', slots.mood);
  put('language', slots.language);
  put('type', slots.type);
  put('plan', slots.plan);
  put('maturity', slots.maturity);
  put('award', slots.award);
  put('year', slots.year);
  put('yearFrom', slots.yearFrom);
  put('yearTo', slots.yearTo);
  put('minRating', slots.minRating);
  put('maxDuration', slots.maxDuration);
  put('minDuration', slots.minDuration);
  put('q', slots.q);

  if (slots.role === 'director') put('director', slots.person);
  else if (slots.person) put('person', slots.person);

  put('sort', slots.sort || defaultSort(slots));
  put('limit', limit);
  return params.toString();
}

function defaultSort(slots) {
  if (slots.minRating) return 'rating';
  if (slots.year || slots.yearFrom) return 'year';
  return 'popularity';
}

/**
 * A one-line explanation of why these results came back.
 * Users trust a recommender far more when it tells them what it did.
 */
export function explain(intent, slots, resultCount) {
  // Personalised intents are about the user, not about filters.
  if (PERSONALIZED_INTENTS.has(intent)) {
    const label = {
      continue_watching: 'picking up where you left off',
      unfinished: 'titles you started but never finished',
      most_watched_by_me: 'the titles you replay most',
      because_you_watched: slots.seedTitle
        ? `based on ${slots.seedTitle}`
        : 'based on your viewing history'
    }[intent];
    return `${resultCount} result${resultCount === 1 ? '' : 's'}: ${label}`;
  }

  const bits = [];
  if (slots.genre) bits.push(`${slots.genre}`);
  if (slots.mood) bits.push(`${slots.mood} mood`);
  if (slots.language) bits.push(`in ${slots.language}`);
  if (slots.type) bits.push(pluralType(slots.type));
  if (slots.year) bits.push(`from ${slots.year}`);
  if (slots.yearFrom && slots.yearTo) bits.push(`from ${slots.yearFrom}-${slots.yearTo}`);
  if (slots.minRating) bits.push(`rated ${slots.minRating}+`);
  if (slots.maxDuration) bits.push(`under ${slots.maxDuration} min`);
  if (slots.minDuration) bits.push(`over ${slots.minDuration} min`);
  if (slots.person) bits.push(`${slots.role === 'director' ? 'directed by' : 'starring'} ${slots.person}`);
  if (slots.award) bits.push(`${slots.award} winners`);
  if (slots.plan) bits.push(`in the ${slots.plan} plan`);
  if (slots.maturity === 'U') bits.push('suitable for all ages');
  if (slots.seedTitle) bits.push(`similar to ${slots.seedTitle}`);
  if (slots.q) bits.push(`matching "${slots.q}"`);

  const what = bits.length ? bits.join(', ') : 'popular right now';
  return `${resultCount} result${resultCount === 1 ? '' : 's'}: ${what}`;
}

/** "series" is already plural; "movie" is not. */
function pluralType(type) {
  return type === 'series' ? 'series' : `${type}s`;
}

/** Deterministic shuffle so "surprise me" is varied but reproducible per seed. */
export function seededShuffle(items, seed = 1) {
  const out = [...items];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Never recommend something the user has already finished. */
export function excludeCompleted(items, history = []) {
  const completed = new Set(history.filter((h) => h.completed).map((h) => h.titleId));
  return items.filter((t) => !completed.has(t.id));
}
