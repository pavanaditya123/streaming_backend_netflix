import { getMemoryDb } from '@streaming/shared';
import { matchesFilters, compareBy, similarityScore } from '../domain/filters.js';

/** In-memory catalog repository (DATA_DRIVER=memory). */
export function createMemoryCatalogRepo(db = getMemoryDb()) {
  const titles = db.table('titles', { primaryKey: 'id' });

  return {
    async upsertMany(rows) {
      for (const row of rows) {
        titles.upsert({
          viewCount: 0,
          addedAt: new Date().toISOString(),
          moods: [],
          awards: [],
          cast: [],
          ...row
        });
      }
      return titles.count();
    },

    async findById(id) {
      return titles.findByPk(id);
    },

    async findManyByIds(ids) {
      return ids.map((id) => titles.findByPk(id)).filter(Boolean);
    },

    async search(filters = {}, { sort = 'popularity', limit = 20, offset = 0 } = {}) {
      const all = titles.find((t) => matchesFilters(t, filters));
      all.sort(compareBy(sort));
      return { items: all.slice(offset, offset + limit), total: all.length };
    },

    async trending(limit = 10) {
      const all = titles.find(() => true);
      all.sort((a, b) => b.viewCount - a.viewCount || b.rating - a.rating);
      return all.slice(0, limit);
    },

    async similar(id, limit = 8) {
      const seed = titles.findByPk(id);
      if (!seed) return [];
      const scored = titles
        .find((t) => t.id !== id)
        .map((t) => ({ t, score: similarityScore(seed, t) }))
        .sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => ({ ...s.t, similarityScore: Number(s.score.toFixed(2)) }));
    },

    async incrementViews(id, by = 1) {
      const row = titles.findByPk(id);
      if (!row) return null;
      return titles.update(id, { viewCount: (row.viewCount || 0) + by });
    },

    async facets() {
      const all = titles.find(() => true);
      const uniq = (vals) => [...new Set(vals)].sort();
      return {
        genres: uniq(all.flatMap((t) => t.genres)),
        languages: uniq(all.map((t) => t.language)),
        moods: uniq(all.flatMap((t) => t.moods || [])),
        types: uniq(all.map((t) => t.type)),
        years: { min: Math.min(...all.map((t) => t.year)), max: Math.max(...all.map((t) => t.year)) },
        count: all.length
      };
    },

    async count() {
      return titles.count();
    }
  };
}
