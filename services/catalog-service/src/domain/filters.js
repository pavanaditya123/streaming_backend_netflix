/**
 * Pure filtering/sorting logic for the catalog.
 *
 * Kept free of I/O so it can be unit tested directly, and so the memory and
 * Postgres repositories agree on what a filter *means*.
 */

export const SORTABLE = ['popularity', 'rating', 'year', 'title', 'recent'];

export function matchesFilters(title, f = {}) {
  if (f.type && title.type !== f.type) return false;
  if (f.language && title.language !== f.language) return false;
  if (f.genre && !title.genres.includes(f.genre)) return false;
  if (f.mood && !(title.moods || []).includes(f.mood)) return false;
  if (f.award && !(title.awards || []).includes(f.award)) return false;
  if (f.plan && !title.plans.includes(f.plan)) return false;
  if (f.maturity && title.maturity !== f.maturity) return false;
  if (f.year && title.year !== f.year) return false;
  if (f.yearFrom && title.year < f.yearFrom) return false;
  if (f.yearTo && title.year > f.yearTo) return false;
  if (f.minRating && title.rating < f.minRating) return false;
  if (f.maxDuration && title.durationMinutes > f.maxDuration) return false;
  if (f.minDuration && title.durationMinutes < f.minDuration) return false;
  if (f.person && !personMatches(title, f.person)) return false;
  if (f.director && !norm(title.director).includes(norm(f.director))) return false;
  if (f.q && !textMatches(title, f.q)) return false;
  return true;
}

const norm = (s) => String(s || '').toLowerCase().trim();

export function personMatches(title, person) {
  const needle = norm(person);
  return (
    (title.cast || []).some((c) => norm(c).includes(needle)) || norm(title.director).includes(needle)
  );
}

export function textMatches(title, q) {
  const needle = norm(q);
  if (!needle) return true;
  const haystack = [
    title.title,
    title.description,
    title.director,
    ...(title.cast || []),
    ...(title.genres || []),
    ...(title.moods || [])
  ]
    .map(norm)
    .join(' ');
  // Every word in the query must appear somewhere — a cheap AND-match that
  // behaves predictably without pulling in a search engine.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

export function compareBy(sort = 'popularity') {
  switch (sort) {
    case 'rating':
      return (a, b) => b.rating - a.rating || b.viewCount - a.viewCount;
    case 'year':
      return (a, b) => b.year - a.year || b.rating - a.rating;
    case 'title':
      return (a, b) => a.title.localeCompare(b.title);
    case 'recent':
      return (a, b) => new Date(b.addedAt) - new Date(a.addedAt) || b.year - a.year;
    case 'popularity':
    default:
      return (a, b) => b.viewCount - a.viewCount || b.rating - a.rating;
  }
}

/**
 * Similarity score used by "more like this".
 * Shared genres dominate, then mood, then same director/cast, then closeness in era.
 */
export function similarityScore(a, b) {
  if (a.id === b.id) return -1;
  const shared = (x = [], y = []) => x.filter((v) => y.includes(v)).length;

  let score = shared(a.genres, b.genres) * 3;
  score += shared(a.moods || [], b.moods || []) * 2;
  if (a.director && a.director === b.director) score += 2;
  score += shared(a.cast || [], b.cast || []) * 2;
  if (a.language === b.language) score += 1;
  if (Math.abs(a.year - b.year) <= 5) score += 1;
  score += b.rating / 10;
  return score;
}
