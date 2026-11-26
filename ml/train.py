"""Train, tune and evaluate the recommenders on MovieLens.

    python ml/train.py            # full run, logs to MLflow + ml/results/
    python ml/train.py --no-mlflow

Protocol
  1. Clean ratings with Pandas, keep ratings >= 4 as implicit positives.
  2. Per-user temporal split: oldest 70% train, next 10% validation, newest 20% test.
  3. Grid-search each model on validation NDCG@10 (fit on train only).
  4. Refit the winners on train + validation and score the test set once.
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from recommender import data as data_mod  # noqa: E402
from recommender.metrics import evaluate  # noqa: E402
from recommender.models import ContentTfidf, Hybrid, ItemKNN, Popularity, PureSVD, recommend  # noqa: E402
from recommender.split import temporal_split  # noqa: E402

K = 10
RESULTS = ROOT / "results"

GRIDS = {
    "popularity": [{}],
    "item_knn": [{"k": k, "shrink": s} for k in (25, 50, 100, 200) for s in (0, 10, 50)],
    "pure_svd": [{"n_factors": f} for f in (16, 32, 64, 128, 256)],
    "content_tfidf": [{"genre_weight": g} for g in (1, 2, 3)],
}
FACTORIES = {"popularity": Popularity, "item_knn": ItemKNN,
             "pure_svd": PureSVD, "content_tfidf": ContentTfidf}


class Matrix:
    """Index mapping between MovieLens ids and matrix rows/columns."""

    def __init__(self, users, movies: pd.DataFrame):
        self.users = np.sort(np.asarray(users))
        self.u_idx = {u: i for i, u in enumerate(self.users)}
        self.i_idx = {m: j for j, m in enumerate(movies.movieId)}
        self.shape = (len(self.users), len(movies))

    def build(self, df: pd.DataFrame) -> sp.csr_matrix:
        rows = df.userId.map(self.u_idx).to_numpy()
        cols = df.movieId.map(self.i_idx).to_numpy()
        return sp.csr_matrix((np.ones(len(df), np.float32), (rows, cols)), shape=self.shape)

    def truth(self, df: pd.DataFrame) -> dict:
        return {self.u_idx[u]: set(g.movieId.map(self.i_idx))
                for u, g in df.groupby("userId")}


def score_model(model, X_seen: sp.csr_matrix, truth: dict, n_items: int) -> dict:
    users = np.array(sorted(truth))
    recs = recommend(model, X_seen[users], K)
    return evaluate({u: list(r) for u, r in zip(users, recs)}, truth, K, n_items)


def tune(name, X_train, truth_val, movies, n_items):
    best, trials = None, []
    for params in GRIDS[name]:
        model = FACTORIES[name](**params).fit(X_train, movies)
        m = score_model(model, X_train, truth_val, n_items)
        trials.append({"params": params, **m})
        if best is None or m[f"ndcg@{K}"] > best[1][f"ndcg@{K}"]:
            best = (params, m)
    return best[0], best[1], trials


def tune_hybrid(models: dict, X_train, truth_val, n_items):
    names = ["item_knn", "pure_svd", "content_tfidf"]
    best = None
    steps = np.round(np.arange(0, 1.01, 0.1), 2)
    for w1, w2 in itertools.product(steps, steps):
        w3 = round(1 - w1 - w2, 2)
        if w3 < 0:
            continue
        hybrid = Hybrid([models[n] for n in names], [w1, w2, w3])
        m = score_model(hybrid, X_train, truth_val, n_items)
        if best is None or m[f"ndcg@{K}"] > best[1][f"ndcg@{K}"]:
            best = ({"weights": dict(zip(names, [float(w1), float(w2), float(w3)]))}, m)
    return best


def main(use_mlflow: bool = True):
    t0 = time.time()
    ds = data_mod.load()
    train, val, test = temporal_split(ds.interactions)
    mx = Matrix(ds.interactions.userId.unique(), ds.movies)
    n_items = mx.shape[1]
    X_train, X_trainval = mx.build(train), mx.build(pd.concat([train, val]))
    truth_val, truth_test = mx.truth(val), mx.truth(test)
    print(f"data: {ds.report}")
    print(f"split: train={len(train)} val={len(val)} test={len(test)}")

    results = {"data": ds.report,
               "split": {"train": len(train), "val": len(val), "test": len(test),
                         "protocol": "per-user temporal 70/10/20"},
               "k": K, "models": {}}
    fitted_val, fitted_test = {}, {}

    for name in GRIDS:
        params, val_m, trials = tune(name, X_train, truth_val, ds.movies, n_items)
        fitted_val[name] = FACTORIES[name](**params).fit(X_train, ds.movies)
        fitted_test[name] = FACTORIES[name](**params).fit(X_trainval, ds.movies)
        test_m = score_model(fitted_test[name], X_trainval, truth_test, n_items)
        results["models"][name] = {"params": params, "val": val_m, "test": test_m,
                                   "trials": trials}
        print(f"{name:14s} {params}  val ndcg={val_m['ndcg@10']:.4f}  test ndcg={test_m['ndcg@10']:.4f}")

    h_params, h_val = tune_hybrid(fitted_val, X_train, truth_val, n_items)
    names = list(h_params["weights"])
    hybrid = Hybrid([fitted_test[n] for n in names], list(h_params["weights"].values()))
    h_test = score_model(hybrid, X_trainval, truth_test, n_items)
    results["models"]["hybrid"] = {"params": h_params, "val": h_val, "test": h_test}
    print(f"{'hybrid':14s} {h_params}  val ndcg={h_val['ndcg@10']:.4f}  test ndcg={h_test['ndcg@10']:.4f}")

    base = results["models"]["popularity"]["test"][f"ndcg@{K}"]
    # Choose on validation, never on test: picking by test score would leak it.
    best_name = max(results["models"], key=lambda n: results["models"][n]["val"][f"ndcg@{K}"])
    results["best_model"] = best_name
    results["ndcg_lift_over_popularity_pct"] = round(
        100 * (results["models"][best_name]["test"][f"ndcg@{K}"] / base - 1), 1)
    results["runtime_seconds"] = round(time.time() - t0, 1)

    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "metrics.json").write_text(json.dumps(results, indent=2, default=str))
    (RESULTS / "RESULTS.md").write_text(render_table(results))
    print(render_table(results))

    if use_mlflow:
        log_mlflow(results)
    return results


def render_table(results: dict) -> str:
    cols = ["precision@10", "recall@10", "ndcg@10", "hit_rate@10", "coverage@10"]
    lines = ["# Test-set results (MovieLens latest-small, per-user temporal split)", "",
             f"Users evaluated: {results['models']['popularity']['test']['users_evaluated']}. "
             f"Model selected on validation NDCG@10: **{results['best_model']}**, test NDCG@10 "
             f"{results['ndcg_lift_over_popularity_pct']:+.1f}% vs. popularity baseline.", "",
             "| Model | Params | " + " | ".join(cols) + " |",
             "|---|---|" + "---|" * len(cols)]
    for name, r in results["models"].items():
        lines.append(f"| {name} | `{json.dumps(r['params'])}` | "
                     + " | ".join(f"{r['test'][c]:.4f}" for c in cols) + " |")
    return "\n".join(lines) + "\n"


def log_mlflow(results: dict):
    try:
        import mlflow
    except ImportError:
        print("mlflow not installed; skipped tracking")
        return
    mlflow.set_tracking_uri(f"sqlite:///{(ROOT / 'mlflow.db').as_posix()}")
    mlflow.set_experiment("streaming-recommender")
    for name, r in results["models"].items():
        with mlflow.start_run(run_name=name):
            mlflow.log_params({"model": name, "k": results["k"],
                               **{k: str(v) for k, v in r["params"].items()}})
            mlflow.log_metrics({f"val_{k.replace('@', '_at_')}": v
                                for k, v in r["val"].items() if isinstance(v, float)})
            mlflow.log_metrics({f"test_{k.replace('@', '_at_')}": v
                                for k, v in r["test"].items() if isinstance(v, float)})
            mlflow.set_tags({"split": results["split"]["protocol"],
                             "dataset": "movielens-latest-small"})
    print(f"MLflow: {len(results['models'])} runs logged to {ROOT / 'mlflow.db'}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-mlflow", action="store_true")
    main(use_mlflow=not ap.parse_args().no_mlflow)
