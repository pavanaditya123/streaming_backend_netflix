"""Build the title-neighbour artifact that recommendation-service serves.

    python ml/build_catalog_model.py

The platform catalog has no interaction log yet, so the collaborative models
evaluated in ``train.py`` have nothing to learn from here. This builds the
cold-start model instead: TF-IDF over each title's metadata, cosine similarity,
top-N neighbours per title. The Node service combines a user's watch history
with these neighbours at request time (see personal-ranker.js).

Once watch-history volume allows it, the same artifact format can be filled
from ItemKNN trained on real plays, with no change to the service.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "services" / "recommendation-service" / "src" / "domain" / "model" / "title-neighbors.json"
N_NEIGHBORS = 10


def load_titles() -> pd.DataFrame:
    raw = subprocess.run(["node", str(ROOT / "export_titles.mjs")], capture_output=True,
                         text=True, check=True, encoding="utf-8").stdout
    return pd.DataFrame(json.loads(raw))


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def title_document(t: pd.Series) -> str:
    """One bag-of-tokens per title; structured fields get prefixed tokens so
    'drama' the genre never collides with 'drama' in a description."""
    parts = []
    parts += [f"genre_{_slug(g)}" for g in t.genres] * 2       # genre matters most
    parts += [f"mood_{_slug(m)}" for m in t.moods]
    parts += [f"lang_{t.language}", f"type_{t.type}", f"decade_{t.year // 10}0s"]
    if t.director:
        parts.append(f"dir_{_slug(t.director)}")
    parts += [f"cast_{_slug(c)}" for c in t.cast]
    parts.append(t.description.lower())
    return " ".join(parts)


def build(titles: pd.DataFrame, n_neighbors: int = N_NEIGHBORS) -> dict:
    docs = titles.apply(title_document, axis=1)
    vec = TfidfVectorizer(token_pattern=r"[a-z0-9_]+", stop_words="english", sublinear_tf=True)
    sim = cosine_similarity(vec.fit_transform(docs))
    np.fill_diagonal(sim, -1.0)
    ids = titles.id.tolist()
    neighbors = {}
    for i, tid in enumerate(ids):
        order = np.argsort(-sim[i])[:n_neighbors]
        neighbors[tid] = [{"id": ids[j], "score": round(float(sim[i, j]), 4)}
                          for j in order if sim[i, j] > 0]
    # No timestamp: the same catalog must produce a byte-identical artifact,
    # so CI can rebuild it and fail if the committed copy is stale.
    return {
        "model": "content-tfidf",
        "titles": len(ids),
        "neighborsPerTitle": n_neighbors,
        "features": "genre x2, mood, language, type, decade, director, cast, description",
        "vocabularySize": len(vec.vocabulary_),
        "neighbors": neighbors,
    }


def main():
    titles = load_titles()
    artifact = build(titles)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(artifact, indent=1, ensure_ascii=False) + "\n",
                   encoding="utf-8", newline="\n")
    sample = titles.id.iloc[0]
    print(f"wrote {OUT.relative_to(ROOT.parent)}: {artifact['titles']} titles, "
          f"vocab {artifact['vocabularySize']}")
    print(f"{sample} ->", [n["id"] for n in artifact["neighbors"][sample][:5]])


if __name__ == "__main__":
    main()
