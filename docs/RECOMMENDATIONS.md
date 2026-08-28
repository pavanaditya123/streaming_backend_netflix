# Natural-language search

```bash
POST /api/v1/recommendations/search
{ "query": "korean thriller series", "limit": 12 }
```

```json
{
  "query": "korean thriller series",
  "intent": "by_genre_and_language",
  "slots": { "genre": "thriller", "language": "ko", "type": "series" },
  "confidence": 0.9,
  "explanation": "1 result: thriller, in ko, series",
  "items": [ { "id": "tt_squid_game", "title": "Squid Game", "...": "..." } ],
  "source": "catalog",
  "cached": false,
  "tookMs": 1.4
}
```

## Why rules and not an LLM

This is the most likely thing to be challenged, so the reasoning is explicit.

This runs on the hot path of a search box. The requirements are: sub-millisecond,
deterministic, free, works offline, and every branch independently testable. An
LLM call would add hundreds of milliseconds, cost money per keystroke, and make
results non-reproducible — which also makes them untestable.

The cost of rules is **vocabulary coverage**: the parser only knows the words in
[`lexicon.js`](../services/recommendation-service/src/domain/lexicon.js). That is
a real limitation, and it is mitigated by keeping the vocabulary as *data* — you
add a synonym without touching the parser — and by a keyword-search fallback that
degrades gracefully when nothing matches.

The honest hybrid answer, if this needed to scale to open-ended language: keep
rules on the hot path for the ~90% of queries that are formulaic, and fall back
to an LLM only for queries that hit `by_title_search` with low confidence. The
architecture already supports that — the fallback branch is a single, isolated
place.

## Three stages

```
"korean thriller series"
        │
        ▼  parse  (pure, in-process, ~0.1ms)
{ intent: "by_genre_and_language", slots: { genre, language, type } }
        │
        ▼  resolve  (slots -> catalog query, cached)
GET /titles?genre=thriller&language=ko&type=series&sort=popularity
        │
        ▼  explain
"1 result: thriller, in ko, series"
```

Parsing and resolving are separate modules on purpose: the parser answers *what
did they mean*, the resolver answers *what do I fetch and how do I rank it*. The
parser can then be tested with zero I/O, and ranking can change without touching
any NLP.

## The 26 intents

Ordered most-specific first — the parser returns the first match, so
"korean horror movies from the 90s" must not be swallowed by the generic
`by_genre` rule.

| # | Intent | Matches |
|---|---|---|
| 1 | `continue_watching` | Resume something already started |
| 2 | `unfinished` | Titles started but never finished |
| 3 | `most_watched_by_me` | The user's own most-replayed titles |
| 4 | `because_you_watched` | Personalised from viewing history |
| 5 | `similar_to` | More titles like a specific one |
| 6 | `by_director` | Titles from a specific director |
| 7 | `by_actor` | Titles featuring a specific actor |
| 8 | `award_winning` | Award winners |
| 9 | `included_in_plan` | What a given plan tier includes |
| 10 | `popular_in_region` | Popular in a country |
| 11 | `family_friendly` | Safe for children |
| 12 | `short_content` | Something short |
| 13 | `long_content` | Something long / epic |
| 14 | `by_rating_threshold` | Above a rating cut-off |
| 15 | `binge_series` | A series to binge |
| 16 | `by_decade` | From a decade |
| 17 | `new_releases` | Recently added / newest |
| 18 | `trending_now` | What everyone is watching |
| 19 | `top_rated` | Highest rated |
| 20 | `by_year` | From a specific year |
| 21 | `by_genre_and_language` | Genre combined with a language |
| 22 | `by_mood` | Match a mood rather than a genre |
| 23 | `by_language` | In a specific language |
| 24 | `by_genre` | A plain genre browse |
| 25 | `random_pick` | Just pick something |
| 26 | `by_title_search` | Fallback keyword search over the catalog |

Live list: `GET /api/v1/recommendations/intents`.

## Slot extraction

Beyond picking an intent, the parser pulls structured values out of the text:

| Query | Slots |
|---|---|
| `90s movies rated above 8` | `{ minRating: 8, yearFrom: 1990, yearTo: 1999, type: "movie" }` |
| `movies under 2 hours` | `{ maxDuration: 120, type: "movie" }` |
| `korean thriller series` | `{ genre: "thriller", language: "ko", type: "series" }` |
| `something like Inception` | `{ seedTitleId: "tt_inception", seedTitle: "Inception" }` |
| `films directed by Christopher Nolan` | `{ person: "christopher nolan", role: "director" }` |

Two rules that took a round of fixing, both now regression-tested:

**Longest match wins.** "space station documentary" mentions *space* (→ sci-fi)
and *documentary*. The longer, more specific word is the better read of intent.

**Constraints combine.** "90s movies rated above 8" matches `by_rating_threshold`,
but it must still carry the decade. Whichever intent fires keeps the other slots
rather than silently dropping them.

## Personalisation

Four intents need the user's own history — `continue_watching`, `unfinished`,
`most_watched_by_me`, `because_you_watched`. Those call `watch-history-service`,
and cache under the **user's** id; everything else caches under `all`, so
non-personalised queries are shared across users.

If watch-history is down, the search degrades to non-personalised results rather
than failing:

```js
catch (err) {
  log.warn({ err: err.message }, 'watch-history unavailable — degrading');
  return [];
}
```

## Graceful behaviour

- **No results** → retry with the narrowest filters (rating, duration, exact
  year) removed, and say so via `source: "relaxed filters (no exact match)"`.
  An over-specific query gets *something* rather than an empty screen.
- **No match at all** → `by_title_search` keyword fallback with
  `confidence: 0.4` and `fallback: true`, so the client can present it
  differently.
- **Empty query** → trending.
- **Catalog vocabulary unavailable** → title/actor references stop resolving but
  genre, mood and language parsing still work.

## The explanation field

Every response says what it did in one line: *"3 results: movies, from
1990-1999, rated 8+"*. A recommender that shows its reasoning is far easier to
trust and far easier to debug — when a result looks wrong, the explanation
usually shows immediately whether the parse or the ranking was at fault.

## Testing

48 tests in
[`intent-parser.test.js`](../services/recommendation-service/test/intent-parser.test.js):
30 classification cases, slot extraction, and robustness — including that it
never throws on `null`, emoji, or a 500-character string, and that 1000 parses
average well under 2 ms.
