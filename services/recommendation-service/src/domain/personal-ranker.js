import { readFileSync } from 'node:fs';

/**
 * Personalised ranking from the offline model artifact.
 *
 * ml/build_catalog_model.py writes title-neighbors.json: for each title, its
 * nearest titles with a similarity score. Here every title in a user's history
 * "votes" for its neighbours, weighted by how strongly the user engaged with it
 * and how recently. Pure function, no I/O at request time.
 */
const ARTIFACT_URL = new URL('./model/title-neighbors.json', import.meta.url);

export function loadModel(url = ARTIFACT_URL) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

const DAY_MS = 86_400_000;

/** How much one history entry should count. */
export function engagementWeight(entry, { now = Date.now(), halfLifeDays = 30 } = {}) {
  const progress = entry.completed ? 1 : Math.max((entry.progressPercent ?? 0) / 100, 0.2);
  const repeat = 1 + Math.log1p(Math.max((entry.playCount ?? 1) - 1, 0));
  const watchedAt = entry.lastWatchedAt ? Date.parse(entry.lastWatchedAt) : NaN;
  const ageDays = Number.isFinite(watchedAt) ? Math.max(now - watchedAt, 0) / DAY_MS : 0;
  const recency = 0.5 ** (ageDays / halfLifeDays);
  return progress * repeat * recency;
}

/**
 * @param history  watch-history entries ({ titleId, completed, progressPercent, playCount, lastWatchedAt })
 * @param model    the loaded artifact
 * @returns        [{ titleId, score, because }] best first, excluding anything already in history
 */
export function rankForUser(history, model, { limit = 12, now = Date.now(), halfLifeDays = 30 } = {}) {
  const seen = new Set(history.map((h) => h.titleId));
  const scores = new Map();

  for (const entry of history) {
    const weight = engagementWeight(entry, { now, halfLifeDays });
    for (const { id, score } of model.neighbors[entry.titleId] || []) {
      if (seen.has(id)) continue;
      const contribution = weight * score;
      const current = scores.get(id) || { titleId: id, score: 0, because: null, best: 0 };
      current.score += contribution;
      if (contribution > current.best) {
        current.best = contribution;
        current.because = entry.titleId;
      }
      scores.set(id, current);
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.titleId.localeCompare(b.titleId))
    .slice(0, limit)
    .map(({ titleId, score, because }) => ({ titleId, score: Number(score.toFixed(4)), because }));
}
