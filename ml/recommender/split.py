"""Per-user temporal split: train on the past, validate and test on the future.

A random split would let a model "see" a user's 2019 likes while predicting
their 2015 ones. Here each user's positives are sorted by time; the newest
``test_frac`` go to test, the slice before that to validation, the rest to
train. Hyperparameters are tuned on validation only; test is scored once.
"""
from __future__ import annotations

import pandas as pd


def temporal_split(interactions: pd.DataFrame, val_frac: float = 0.1,
                   test_frac: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    df = interactions.sort_values(["userId", "timestamp", "movieId"]).copy()
    df["rank"] = df.groupby("userId").cumcount()
    n = df.groupby("userId").movieId.transform("size")
    n_test = (n * test_frac).round().clip(lower=1)
    n_val = (n * val_frac).round().clip(lower=1)
    is_test = df["rank"] >= n - n_test
    is_val = ~is_test & (df["rank"] >= n - n_test - n_val)
    cols = ["userId", "movieId", "timestamp"]
    return df.loc[~is_test & ~is_val, cols], df.loc[is_val, cols], df.loc[is_test, cols]
