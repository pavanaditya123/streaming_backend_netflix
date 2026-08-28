import { postgres } from '@streaming/shared';

const { query } = postgres;

/**
 * Column list shared by every read, mapped to the camelCase shape the API
 * returns. Built with a table alias because the similarity query joins the
 * table to itself, where bare column names would be ambiguous.
 */
const selectTitle = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `
  ${p}id, ${p}title, ${p}type, ${p}year, ${p}genres, ${p}language, ${p}country,
  ${p}duration_minutes AS "durationMinutes",
  ${p}seasons, ${p}episodes, ${p}rating, ${p}maturity, ${p}director,
  ${p}cast_members AS "cast",
  ${p}moods, ${p}awards, ${p}plans, ${p}description,
  ${p}view_count AS "viewCount",
  ${p}added_at   AS "addedAt"
`;
};

const SELECT_TITLE = selectTitle();

/**
 * Postgres catalog repository (DATA_DRIVER=postgres).
 *
 * Filters are composed into a parameterised WHERE clause — never string
 * concatenation of user input.
 */
export function createPgCatalogRepo() {
  function buildWhere(f = {}) {
    const clauses = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };

    if (f.type) add('type = ?', f.type);
    if (f.language) add('language = ?', f.language);
    if (f.genre) add('genres @> ARRAY[?]::text[]', f.genre);
    if (f.mood) add('moods @> ARRAY[?]::text[]', f.mood);
    if (f.award) add('awards @> ARRAY[?]::text[]', f.award);
    if (f.plan) add('plans @> ARRAY[?]::text[]', f.plan);
    if (f.maturity) add('maturity = ?', f.maturity);
    if (f.year) add('year = ?', f.year);
    if (f.yearFrom) add('year >= ?', f.yearFrom);
    if (f.yearTo) add('year <= ?', f.yearTo);
    if (f.minRating) add('rating >= ?', f.minRating);
    if (f.maxDuration) add('duration_minutes <= ?', f.maxDuration);
    if (f.minDuration) add('duration_minutes >= ?', f.minDuration);
    if (f.director) add('director ILIKE ?', `%${f.director}%`);
    if (f.person) {
      params.push(`%${f.person}%`);
      const p = `$${params.length}`;
      clauses.push(`(director ILIKE ${p} OR EXISTS (SELECT 1 FROM unnest(cast_members) c WHERE c ILIKE ${p}))`);
    }
    if (f.q) {
      // search_vector is a generated tsvector column with a GIN index on it.
      add('search_vector @@ plainto_tsquery(\'simple\', ?)', f.q);
    }

    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  const ORDER = {
    popularity: 'view_count DESC, rating DESC',
    rating: 'rating DESC, view_count DESC',
    year: 'year DESC, rating DESC',
    title: 'title ASC',
    recent: 'added_at DESC, year DESC'
  };

  return {
    async upsertMany(rows) {
      for (const r of rows) {
        await query(
          `INSERT INTO catalog.titles
             (id, title, type, year, genres, language, country, duration_minutes, seasons, episodes,
              rating, maturity, director, cast_members, moods, awards, plans, description, view_count, added_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,0),COALESCE($20,NOW()))
           ON CONFLICT (id) DO UPDATE SET
             title=EXCLUDED.title, type=EXCLUDED.type, year=EXCLUDED.year, genres=EXCLUDED.genres,
             language=EXCLUDED.language, country=EXCLUDED.country, duration_minutes=EXCLUDED.duration_minutes,
             seasons=EXCLUDED.seasons, episodes=EXCLUDED.episodes, rating=EXCLUDED.rating,
             maturity=EXCLUDED.maturity, director=EXCLUDED.director, cast_members=EXCLUDED.cast_members,
             moods=EXCLUDED.moods, awards=EXCLUDED.awards, plans=EXCLUDED.plans, description=EXCLUDED.description`,
          [
            r.id, r.title, r.type, r.year, r.genres, r.language, r.country ?? null,
            r.durationMinutes ?? null, r.seasons ?? null, r.episodes ?? null, r.rating,
            r.maturity, r.director ?? null, r.cast ?? [], r.moods ?? [], r.awards ?? [],
            r.plans ?? [], r.description ?? null, r.viewCount ?? 0, r.addedAt ?? null
          ]
        );
      }
      const { rows: c } = await query('SELECT COUNT(*)::int AS n FROM catalog.titles');
      return c[0].n;
    },

    async findById(id) {
      const { rows } = await query(`SELECT ${SELECT_TITLE} FROM catalog.titles WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async findManyByIds(ids) {
      if (!ids.length) return [];
      const { rows } = await query(`SELECT ${SELECT_TITLE} FROM catalog.titles WHERE id = ANY($1)`, [ids]);
      return rows;
    },

    async search(filters = {}, { sort = 'popularity', limit = 20, offset = 0 } = {}) {
      const { where, params } = buildWhere(filters);
      const order = ORDER[sort] || ORDER.popularity;

      // One round trip for the page and the total, instead of two queries.
      const { rows } = await query(
        `SELECT ${SELECT_TITLE}, COUNT(*) OVER() AS "totalCount"
           FROM catalog.titles ${where}
          ORDER BY ${order}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      const total = rows.length ? Number(rows[0].totalCount) : 0;
      return { items: rows.map(({ totalCount: _t, ...r }) => r), total };
    },

    async trending(limit = 10) {
      const { rows } = await query(
        `SELECT ${SELECT_TITLE} FROM catalog.titles
          ORDER BY view_count DESC, rating DESC LIMIT $1`,
        [limit]
      );
      return rows;
    },

    async similar(id, limit = 8) {
      // Scoring mirrors domain/filters.js#similarityScore, expressed in SQL so
      // the ranking happens in the database instead of in Node memory.
      const { rows } = await query(
        `WITH seed AS (SELECT * FROM catalog.titles WHERE id = $1)
         SELECT ${selectTitle('t')},
                ( cardinality(ARRAY(SELECT unnest(t.genres) INTERSECT SELECT unnest(s.genres))) * 3
                + cardinality(ARRAY(SELECT unnest(t.moods)  INTERSECT SELECT unnest(s.moods)))  * 2
                + CASE WHEN t.director = s.director THEN 2 ELSE 0 END
                + cardinality(ARRAY(SELECT unnest(t.cast_members) INTERSECT SELECT unnest(s.cast_members))) * 2
                + CASE WHEN t.language = s.language THEN 1 ELSE 0 END
                + CASE WHEN abs(t.year - s.year) <= 5 THEN 1 ELSE 0 END
                + t.rating / 10.0
                )::numeric(6,2) AS "similarityScore"
           FROM catalog.titles t, seed s
          WHERE t.id <> s.id
          ORDER BY "similarityScore" DESC, t.rating DESC
          LIMIT $2`,
        [id, limit]
      );
      return rows;
    },

    async incrementViews(id, by = 1) {
      const { rows } = await query(
        `UPDATE catalog.titles SET view_count = view_count + $2 WHERE id = $1 RETURNING ${SELECT_TITLE}`,
        [id, by]
      );
      return rows[0] || null;
    },

    async facets() {
      const { rows } = await query(
        `SELECT
           ARRAY(SELECT DISTINCT unnest(genres) FROM catalog.titles ORDER BY 1) AS genres,
           ARRAY(SELECT DISTINCT language      FROM catalog.titles ORDER BY 1) AS languages,
           ARRAY(SELECT DISTINCT unnest(moods)  FROM catalog.titles ORDER BY 1) AS moods,
           ARRAY(SELECT DISTINCT type          FROM catalog.titles ORDER BY 1) AS types,
           MIN(year) AS min_year, MAX(year) AS max_year, COUNT(*)::int AS count
         FROM catalog.titles`
      );
      const r = rows[0];
      return {
        genres: r.genres, languages: r.languages, moods: r.moods, types: r.types,
        years: { min: r.min_year, max: r.max_year }, count: r.count
      };
    },

    async count() {
      const { rows } = await query('SELECT COUNT(*)::int AS n FROM catalog.titles');
      return rows[0].n;
    }
  };
}
