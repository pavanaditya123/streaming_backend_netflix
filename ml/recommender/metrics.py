"""Top-K ranking metrics, averaged over users."""
from __future__ import annotations

import numpy as np


def precision_at_k(recs: list, relevant: set, k: int) -> float:
    return len(set(recs[:k]) & relevant) / k


def recall_at_k(recs: list, relevant: set, k: int) -> float:
    return len(set(recs[:k]) & relevant) / len(relevant) if relevant else 0.0


def ndcg_at_k(recs: list, relevant: set, k: int) -> float:
    dcg = sum(1 / np.log2(i + 2) for i, item in enumerate(recs[:k]) if item in relevant)
    ideal = sum(1 / np.log2(i + 2) for i in range(min(len(relevant), k)))
    return dcg / ideal if ideal else 0.0


def hit_rate_at_k(recs: list, relevant: set, k: int) -> float:
    return float(bool(set(recs[:k]) & relevant))


def evaluate(recommendations: dict, truth: dict, k: int = 10, n_items: int | None = None) -> dict:
    """recommendations / truth: userId -> list of items / set of held-out items."""
    users = [u for u in truth if truth[u]]
    rows = np.array([[precision_at_k(recommendations[u], truth[u], k),
                      recall_at_k(recommendations[u], truth[u], k),
                      ndcg_at_k(recommendations[u], truth[u], k),
                      hit_rate_at_k(recommendations[u], truth[u], k)] for u in users])
    p, r, n, h = rows.mean(axis=0)
    out = {f"precision@{k}": p, f"recall@{k}": r, f"ndcg@{k}": n, f"hit_rate@{k}": h,
           "users_evaluated": len(users)}
    if n_items:
        shown = {i for u in users for i in recommendations[u][:k]}
        out[f"coverage@{k}"] = len(shown) / n_items
    return {key: (round(float(v), 4) if isinstance(v, float) else v) for key, v in out.items()}
