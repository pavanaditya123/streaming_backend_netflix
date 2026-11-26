"""Load and clean MovieLens interactions with Pandas.

Ratings are explicit (0.5-5 stars), but a home rail predicts what someone will
*watch*, not how many stars they give. So ratings are turned into implicit
positives: a rating at or above ``POSITIVE_THRESHOLD`` counts as "liked".
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "ml-latest-small"
POSITIVE_THRESHOLD = 4.0
MIN_USER_POSITIVES = 10


@dataclass
class Dataset:
    interactions: pd.DataFrame  # userId, movieId, timestamp (positives only)
    movies: pd.DataFrame        # movieId, title, genres, tags, year
    report: dict                # what cleaning removed, for the run log


def load_raw(data_dir: Path = DATA_DIR) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    ratings = pd.read_csv(data_dir / "ratings.csv")
    movies = pd.read_csv(data_dir / "movies.csv")
    tags = pd.read_csv(data_dir / "tags.csv")
    return ratings, movies, tags


def clean(ratings: pd.DataFrame, movies: pd.DataFrame, tags: pd.DataFrame,
          threshold: float = POSITIVE_THRESHOLD,
          min_user_positives: int = MIN_USER_POSITIVES) -> Dataset:
    report = {"raw_ratings": len(ratings), "raw_users": ratings.userId.nunique(),
              "raw_movies": len(movies)}

    ratings = ratings.dropna(subset=["userId", "movieId", "rating", "timestamp"])
    # A user re-rating the same movie: keep the latest opinion.
    before = len(ratings)
    ratings = (ratings.sort_values("timestamp")
                      .drop_duplicates(["userId", "movieId"], keep="last"))
    report["duplicate_ratings_dropped"] = before - len(ratings)

    ratings = ratings[ratings.movieId.isin(movies.movieId)]
    positives = ratings[ratings.rating >= threshold][["userId", "movieId", "timestamp"]]
    report["positive_interactions"] = len(positives)

    # Users with too few positives can't be split into train/val/test.
    counts = positives.groupby("userId").size()
    keep = counts[counts >= min_user_positives].index
    report["users_dropped_too_few_positives"] = int((counts < min_user_positives).sum())
    positives = positives[positives.userId.isin(keep)].reset_index(drop=True)

    movies = _movie_features(movies, tags)
    report.update(users=int(positives.userId.nunique()),
                  items_with_positives=int(positives.movieId.nunique()),
                  interactions=len(positives))
    report["density_pct"] = round(
        100 * len(positives) / (report["users"] * len(movies)), 3)
    return Dataset(positives, movies, report)


def _movie_features(movies: pd.DataFrame, tags: pd.DataFrame) -> pd.DataFrame:
    movies = movies.copy()
    movies["year"] = pd.to_numeric(
        movies.title.str.extract(r"\((\d{4})\)\s*$")[0], errors="coerce")
    movies["genres"] = (movies.genres.replace("(no genres listed)", "")
                                     .str.replace("|", " ", regex=False)
                                     .str.lower())
    tag_text = (tags.assign(tag=tags.tag.astype(str).str.lower().str.strip())
                    .groupby("movieId").tag.apply(" ".join))
    movies["tags"] = movies.movieId.map(tag_text).fillna("")
    return movies


def load(data_dir: Path = DATA_DIR, **kwargs) -> Dataset:
    return clean(*load_raw(data_dir), **kwargs)
