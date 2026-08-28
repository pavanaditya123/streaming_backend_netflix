/**
 * The parser needs to recognise real title/actor/director names, and those live
 * in catalog-service. Fetching them on every search would be wasteful, so they
 * are pulled once and refreshed on a TTL.
 */
export function createVocabulary({ catalogClient, ttlMs = 300_000 }) {
  let cached = null;
  let loadedAt = 0;
  let inFlight = null;

  async function load(ctx) {
    const res = await catalogClient.get('/titles?limit=100&sort=rating', ctx);
    const titles = res.items || [];
    return {
      titles: titles.map((t) => ({ id: t.id, title: t.title })),
      actors: [...new Set(titles.flatMap((t) => t.cast || []))],
      directors: [...new Set(titles.map((t) => t.director).filter(Boolean))]
    };
  }

  return {
    async get(ctx) {
      const fresh = cached && Date.now() - loadedAt < ttlMs;
      if (fresh) return cached;

      // Collapse concurrent refreshes into one upstream call.
      if (!inFlight) {
        inFlight = load(ctx)
          .then((vocab) => {
            cached = vocab;
            loadedAt = Date.now();
            return vocab;
          })
          .catch(() => cached || { titles: [], actors: [], directors: [] })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },

    /** Test hook. */
    set(vocab) {
      cached = vocab;
      loadedAt = Date.now();
    }
  };
}
