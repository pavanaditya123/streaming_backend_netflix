"""Unit tests for the offline pipeline. They use small synthetic data, so CI
does not need the MovieLens download."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import scipy.sparse as sp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_catalog_model import build  # noqa: E402
from recommender.data import clean  # noqa: E402
from recommender.metrics import evaluate, hit_rate_at_k, ndcg_at_k, precision_at_k, recall_at_k  # noqa: E402
from recommender.models import ContentTfidf, Hybrid, ItemKNN, Popularity, PureSVD, recommend  # noqa: E402
from recommender.split import temporal_split  # noqa: E402


# ---------------------------------------------------------------- metrics
def test_metrics_on_a_hand_checked_case():
    recs, relevant = [1, 2, 3, 4], {2, 4, 9}
    assert precision_at_k(recs, relevant, 4) == 0.5
    assert recall_at_k(recs, relevant, 4) == pytest.approx(2 / 3)
    assert hit_rate_at_k(recs, relevant, 4) == 1.0
    dcg = 1 / np.log2(3) + 1 / np.log2(5)
    idcg = 1 + 1 / np.log2(3) + 1 / np.log2(4)
    assert ndcg_at_k(recs, relevant, 4) == pytest.approx(dcg / idcg)


def test_perfect_ranking_scores_one():
    assert ndcg_at_k([7, 8], {7, 8}, 2) == pytest.approx(1.0)


def test_evaluate_skips_users_with_nothing_held_out():
    out = evaluate({1: [5], 2: [6]}, {1: {5}, 2: set()}, k=1, n_items=10)
    assert out["users_evaluated"] == 1
    assert out["precision@1"] == 1.0
    assert out["coverage@1"] == 0.1


# ---------------------------------------------------------------- data + split
def _ratings(n_users=3, per_user=20):
    rows = [(u, m, 5.0 if m % 2 == 0 else 2.0, 1000 + u * 100 + m)
            for u in range(1, n_users + 1) for m in range(per_user)]
    return pd.DataFrame(rows, columns=["userId", "movieId", "rating", "timestamp"])


def _movies(n=20):
    return pd.DataFrame({"movieId": range(n), "title": [f"M{i} (1999)" for i in range(n)],
                         "genres": ["Action|Comedy" if i % 2 else "Drama" for i in range(n)]})


def test_clean_keeps_only_positives_and_latest_duplicate():
    ratings = _ratings()
    dup = pd.DataFrame([(1, 1, 5.0, 99999)], columns=ratings.columns)  # 2.0 -> re-rated 5.0
    ds = clean(pd.concat([ratings, dup]), _movies(),
               pd.DataFrame(columns=["userId", "movieId", "tag", "timestamp"]),
               min_user_positives=5)
    assert ds.report["duplicate_ratings_dropped"] == 1
    liked = set(ds.interactions.query("userId == 1").movieId)
    assert 1 in liked and 3 not in liked
    assert ds.movies.loc[0, "year"] == 1999


def test_temporal_split_has_no_future_leakage():
    df = _ratings(n_users=5, per_user=30).rename(columns={"rating": "_"})
    train, val, test = temporal_split(df[["userId", "movieId", "timestamp"]])
    assert len(train) + len(val) + len(test) == len(df)
    for u in df.userId.unique():
        tr, va, te = (x[x.userId == u].timestamp for x in (train, val, test))
        assert tr.max() < va.min() <= va.max() < te.min()
        assert len(te) == 6 and len(va) == 3  # 20% / 10% of 30


# ---------------------------------------------------------------- models
@pytest.fixture
def X():
    # Users 0-1 like items {0,1}; users 2-3 like items {2,3}; user 4 likes 0 only.
    rows = [0, 0, 1, 1, 2, 2, 3, 3, 4]
    cols = [0, 1, 0, 1, 2, 3, 2, 3, 0]
    return sp.csr_matrix((np.ones(9, np.float32), (rows, cols)), shape=(5, 5))


def test_recommend_never_returns_seen_items(X):
    for model in (Popularity(), ItemKNN(k=2), PureSVD(n_factors=2)):
        recs = recommend(model.fit(X), X, k=2)
        for u in range(X.shape[0]):
            assert not set(recs[u]) & set(X[u].indices)


def test_item_knn_learns_co_occurrence(X):
    recs = recommend(ItemKNN(k=2, shrink=0).fit(X), X, k=1)
    assert recs[4][0] == 1  # liked 0; 1 is always liked alongside 0


def test_pure_svd_learns_co_occurrence(X):
    recs = recommend(PureSVD(n_factors=2).fit(X), X, k=1)
    assert recs[4][0] == 1


def test_content_model_prefers_same_genre():
    movies = pd.DataFrame({"genres": ["horror", "horror", "comedy", "comedy"],
                           "tags": ["", "", "", ""], "year": [2000] * 4})
    X = sp.csr_matrix(([1.0], ([0], [0])), shape=(1, 4))
    recs = recommend(ContentTfidf(min_df=1).fit(X, movies), X, k=1)
    assert recs[0][0] == 1


def test_hybrid_with_one_full_weight_matches_that_model(X):
    knn = ItemKNN(k=2).fit(X)
    pop = Popularity().fit(X)
    assert (recommend(Hybrid([knn, pop], [1.0, 0.0]), X, 2)
            == recommend(knn, X, 2)).all()


# ---------------------------------------------------------------- serving artifact
def test_catalog_artifact_shape():
    titles = pd.DataFrame([
        dict(id="a", genres=["animation", "family"], moods=["funny"], language="en", type="movie",
             year=1995, director="X", cast=["P"], description="toys come alive"),
        dict(id="b", genres=["animation", "family"], moods=["funny"], language="en", type="movie",
             year=2017, director="Y", cast=["Q"], description="a boy and music"),
        dict(id="c", genres=["horror"], moods=["scary"], language="en", type="movie",
             year=2013, director="Z", cast=["R"], description="a haunted house"),
    ])
    art = build(titles, n_neighbors=2)
    assert art["titles"] == 3
    assert art["neighbors"]["a"][0]["id"] == "b"
    for tid, ns in art["neighbors"].items():
        assert all(n["id"] != tid for n in ns)
