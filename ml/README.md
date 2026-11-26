# ML recommender pipeline

Offline Python pipeline behind the **"Top picks for you"** rail. It has two parts:

| Part | What it does | Data |
|---|---|---|
| `train.py` | Cleans ratings, splits by time, tunes and compares 5 recommenders, logs to MLflow | MovieLens latest-small (100,836 real ratings) |
| `build_catalog_model.py` | Builds the content model the service actually serves, as a JSON artifact | The platform's own 61-title catalog |

Why two? The platform's catalog has no interaction log yet, so collaborative
models have nothing to learn from here. MovieLens is used to measure which
approach wins when interaction data exists, and the live service starts with
the cold-start content model. The artifact format (`title -> [{id, score}]`) is
the same for an ItemKNN model, so swapping one in later needs no service change.

```bash
pip install -r ml/requirements.txt
# download https://files.grouplens.org/datasets/movielens/ml-latest-small.zip into ml/data/ and unzip
python ml/train.py                 # ~35 s on a laptop CPU; writes ml/results/ + MLflow runs
python ml/build_catalog_model.py   # rebuilds services/recommendation-service/src/domain/model/title-neighbors.json
python -m pytest ml/tests -q       # 11 tests, synthetic data, no download needed
mlflow ui --backend-store-uri sqlite:///ml/mlflow.db   # browse runs
```

## Data cleaning (Pandas)

| Step | Effect |
|---|---|
| Drop rows missing ids, rating or timestamp; keep a user's latest rating per movie | 0 duplicates in this release, but handled |
| Ratings >= 4.0 become implicit positives ("liked") | 100,836 ratings -> 48,580 positives |
| Drop users with < 10 positives (cannot be split three ways) | 610 -> 579 users (30 dropped) |
| Parse release year from the title; join user tags per movie | Features for the content model |

Result: 579 users x 9,742 movies, 48,395 positives, **0.86% dense**.

## Evaluation protocol

- **Per-user temporal split** (70 / 10 / 20): each user's oldest likes train,
  the next 10% validate, the newest 20% test. A random split would let models
  use a user's future to predict their past.
- **Tuning on validation only**: 21 grid configurations across the models plus
  a 66-point weight grid for the hybrid, selected on NDCG@10.
- **Test scored once**, after refitting the selected configurations on train + validation.
- Items the user already liked are never recommended.

## Results (test set, 579 users, K = 10)

| Model | Tuned params | Precision@10 | Recall@10 | NDCG@10 | HitRate@10 | Coverage@10 |
|---|---|---|---|---|---|---|
| Popularity (baseline) | — | 0.0491 | 0.0481 | 0.0651 | 0.3143 | 0.6% |
| ItemKNN (cosine, shrunk) | k=25, shrink=10 | 0.0750 | 0.0775 | 0.0957 | 0.4473 | 6.0% |
| PureSVD (matrix factorisation) | 32 factors | 0.0807 | 0.0879 | 0.1045 | 0.4680 | 4.2% |
| Content TF-IDF (genres + tags) | genre weight 1 | 0.0085 | 0.0079 | 0.0098 | 0.0777 | 20.2% |
| **Hybrid (selected on validation)** | 0.6 ItemKNN + 0.4 SVD | 0.0801 | 0.0861 | **0.1027** | **0.4801** | 5.2% |

The hybrid had the best validation NDCG@10 and is the selected model:
**+57.8% NDCG@10 and +16.6 points HitRate@10 over the popularity baseline.**
On test, PureSVD alone scores slightly higher (0.1045); the gap is within
what one split can resolve, and choosing by test would leak it.

**Findings**
- Collaborative models beat popularity by a wide margin once interaction data exists.
- Content-only TF-IDF is ~10x weaker than collaborative filtering here: MovieLens
  genres are coarse and tags are sparse (3,683 tags over 9,742 movies). The tuner
  gave it weight 0 in the hybrid, and blending it with popularity did not help
  either. Its strength is coverage (20% of the catalog vs 0.6%) and cold start.
- That is why the live service uses content similarity only as the cold-start
  model. The 61-title catalog has rich metadata (moods, director, cast,
  descriptions) that MovieLens lacks.

## Serving

`build_catalog_model.py` writes TF-IDF cosine neighbours (top 10 per title) from
genres, moods, language, type, decade, director, cast and description. At
request time `personal-ranker.js` lets every title in the user's history vote
for its neighbours, weighted by completion, repeat plays and a 30-day recency
half-life. It excludes anything already watched and returns the title that
contributed most as the "because" explanation. It does no I/O, so the rail adds
no network hop.

CI runs the pytest suite and rebuilds the artifact, failing if the committed
copy is stale (the build is deterministic: no timestamps, LF line endings).
