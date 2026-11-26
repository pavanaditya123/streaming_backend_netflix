"""Top-N recommenders over an implicit user x item matrix.

Every model exposes ``fit(X, movies)`` and ``score(X_users)``, where ``X`` is a
binary CSR matrix (users x items) and ``score`` returns a dense array of
relevance scores, higher is better. Masking already-seen items and taking the
top K is done once, in ``recommend``.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import scipy.sparse as sp
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize


class Popularity:
    """Baseline: recommend what most users liked. Same list for everyone."""
    name = "popularity"

    def fit(self, X: sp.csr_matrix, movies: pd.DataFrame | None = None):
        self.counts = np.asarray(X.sum(axis=0)).ravel().astype(np.float32)
        return self

    def score(self, X_users: sp.csr_matrix) -> np.ndarray:
        return np.tile(self.counts, (X_users.shape[0], 1))


class ItemKNN:
    """Item-based collaborative filtering with shrunk cosine similarity.

    sim(i, j) = |U_i & U_j| / (sqrt(|U_i| |U_j|) + shrink), keeping only each
    item's ``k`` nearest neighbours. A user's score for item j is the sum of
    similarities between j and the items they already liked.
    """
    name = "item_knn"

    def __init__(self, k: int = 100, shrink: float = 10.0):
        self.k, self.shrink = k, shrink

    def fit(self, X: sp.csr_matrix, movies: pd.DataFrame | None = None):
        X = X.tocsc().astype(np.float32)
        n_items = X.shape[1]
        # Only items someone liked can have neighbours; keeping the dense
        # similarity matrix to those columns cuts memory several-fold.
        active = np.flatnonzero(X.getnnz(axis=0))
        Xa = X[:, active]
        co = (Xa.T @ Xa).toarray()
        norms = np.sqrt(np.diag(co))
        sim = co / (np.outer(norms, norms) + self.shrink)
        np.fill_diagonal(sim, 0.0)
        if self.k < sim.shape[0]:
            # Zero everything except each column's top-k neighbours.
            drop = np.argpartition(-sim, self.k, axis=0)[self.k:]
            np.put_along_axis(sim, drop, 0.0, axis=0)
        sim = sp.coo_matrix(sim)
        self.sim = sp.csr_matrix((sim.data, (active[sim.row], active[sim.col])),
                                 shape=(n_items, n_items))
        return self

    def score(self, X_users: sp.csr_matrix) -> np.ndarray:
        return (X_users @ self.sim).toarray()


class PureSVD:
    """Matrix factorisation: project a user's likes onto the top latent factors.

    score(u) = x_u V^T V, where V holds the item factors from a truncated SVD
    of the interaction matrix (Cremonesi et al., 2010).
    """
    name = "pure_svd"

    def __init__(self, n_factors: int = 64, seed: int = 42):
        self.n_factors, self.seed = n_factors, seed

    def fit(self, X: sp.csr_matrix, movies: pd.DataFrame | None = None):
        svd = TruncatedSVD(n_components=self.n_factors, random_state=self.seed)
        svd.fit(X.astype(np.float32))
        self.V = svd.components_.astype(np.float32)
        return self

    def score(self, X_users: sp.csr_matrix) -> np.ndarray:
        return (X_users @ self.V.T) @ self.V


class ContentTfidf:
    """Content-based: TF-IDF over genres and user tags.

    A user's profile is the normalised sum of the item vectors they liked;
    items are scored by cosine similarity to that profile. Unlike the
    collaborative models, this can recommend items nobody has liked yet.
    """
    name = "content_tfidf"

    def __init__(self, genre_weight: int = 2, min_df: int = 2):
        self.genre_weight, self.min_df = genre_weight, min_df

    def fit(self, X: sp.csr_matrix, movies: pd.DataFrame):
        decade = movies.year.fillna(0).astype(int).floordiv(10).astype(str) + "0s"
        text = ((movies.genres + " ") * self.genre_weight + movies.tags + " decade_" + decade)
        vec = TfidfVectorizer(min_df=self.min_df, token_pattern=r"[a-z0-9_'-]+")
        self.items = normalize(vec.fit_transform(text.values)).astype(np.float32)
        self.vocab_size = len(vec.vocabulary_)
        return self

    def score(self, X_users: sp.csr_matrix) -> np.ndarray:
        profiles = normalize(X_users @ self.items)
        return (profiles @ self.items.T).toarray()


class Hybrid:
    """Weighted blend of already-fitted models, each min-max scaled per user."""
    name = "hybrid"

    def __init__(self, models: list, weights: list[float]):
        self.models, self.weights = models, weights

    def fit(self, X, movies=None):
        return self  # components are fitted by the caller

    def score(self, X_users: sp.csr_matrix) -> np.ndarray:
        total = None
        for model, w in zip(self.models, self.weights):
            s = model.score(X_users)
            lo, hi = s.min(axis=1, keepdims=True), s.max(axis=1, keepdims=True)
            s = (s - lo) / np.where(hi > lo, hi - lo, 1.0)
            total = w * s if total is None else total + w * s
        return total


def recommend(model, X_users: sp.csr_matrix, k: int = 10) -> np.ndarray:
    """Top-k item indices per user, never including items already in X_users."""
    scores = model.score(X_users).astype(np.float32, copy=False)
    rows, cols = X_users.nonzero()
    scores[rows, cols] = -np.inf
    top = np.argpartition(-scores, k, axis=1)[:, :k]
    order = np.take_along_axis(scores, top, axis=1).argsort(axis=1)[:, ::-1]
    return np.take_along_axis(top, order, axis=1)
